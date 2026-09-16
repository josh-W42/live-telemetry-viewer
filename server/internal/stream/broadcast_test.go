package stream_test

import (
	"sync"
	"testing"
	"time"

	telemetryv1 "github.com/josh-W42/sift/server/gen/telemetry/v1"
	"github.com/josh-W42/sift/server/internal/stream"
)

// sample builds a minimal one-sample payload for the named channels.
func sample(channelIDs ...string) []*telemetryv1.ChannelSamples {
	out := make([]*telemetryv1.ChannelSamples, len(channelIDs))
	for i, id := range channelIDs {
		out[i] = &telemetryv1.ChannelSamples{
			ChannelId:    id,
			TimestampsNs: []int64{int64(i)},
			Values:       []float64{float64(i)},
		}
	}
	return out
}

func allChannels() []*telemetryv1.ChannelSamples {
	return sample("chamber_pressure", "chamber_temp", "vibration", "fuel_flow")
}

// --- Acceptance criterion: a slow subscriber must not block others --------

func TestSlowSubscriberDoesNotBlockOthers(t *testing.T) {
	const depth = 8
	const batches = 500

	b := stream.NewBroadcaster(depth)

	// Never read from this one. Its buffer fills immediately.
	slow := b.Subscribe(nil)
	defer slow.Close()

	fast := b.Subscribe(nil)
	defer fast.Close()

	// Publish and read in lockstep. An unpaced publisher would outrun any
	// bounded buffer, including a healthy subscriber's, so pacing here isolates
	// what the test is actually about: whether the starved peer interferes.
	// The real pump publishes every 50ms, which a live reader keeps up with
	// easily.
	var got []uint64
	done := make(chan struct{})

	go func() {
		defer close(done)
		for i := 0; i < batches; i++ {
			b.Publish(allChannels())
			select {
			case batch := <-fast.C():
				got = append(got, batch.Sequence)
			case <-time.After(time.Second):
				return
			}
		}
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Publish blocked on a subscriber that never reads")
	}

	if len(got) != batches {
		t.Errorf("healthy subscriber received %d of %d batches; a starved peer cost it data", len(got), batches)
	}
	for i := range got {
		if want := uint64(i + 1); got[i] != want {
			t.Fatalf("healthy subscriber got sequence %d at position %d, want %d", got[i], i, want)
		}
	}
	if slow.Dropped() == 0 {
		t.Error("starved subscriber recorded no drops, but its buffer must have overflowed")
	}
}

// --- Drop policy ---------------------------------------------------------

// Live telemetry wants the freshest data, so an overflowing buffer discards
// its oldest entry rather than refusing the newest.
func TestDropOldestKeepsTheNewestBatches(t *testing.T) {
	const depth = 4
	b := stream.NewBroadcaster(depth)

	sub := b.Subscribe(nil)
	defer sub.Close()

	const published = 20
	for i := 0; i < published; i++ {
		b.Publish(allChannels())
	}

	var seqs []uint64
	for len(sub.C()) > 0 {
		seqs = append(seqs, (<-sub.C()).Sequence)
	}

	if len(seqs) != depth {
		t.Fatalf("buffer holds %d batches, want %d", len(seqs), depth)
	}
	// Sequences start at 1, so the last `depth` published are published-depth+1..published.
	for i, got := range seqs {
		want := uint64(published - depth + 1 + i)
		if got != want {
			t.Errorf("buffered batch %d has sequence %d, want %d (oldest should have been dropped)", i, got, want)
		}
	}
}

// Every published batch that does not fit costs exactly one drop. Counting
// more would overstate loss in the server's logs and in the client's gap math.
func TestDropCountIsExactlyOnePerLostBatch(t *testing.T) {
	const depth = 4
	const published = 20

	b := stream.NewBroadcaster(depth)
	sub := b.Subscribe(nil)
	defer sub.Close()

	for i := 0; i < published; i++ {
		b.Publish(allChannels())
	}

	if got, want := sub.Dropped(), uint64(published-depth); got != want {
		t.Errorf("dropped %d batches, want exactly %d (published %d, buffer %d)",
			got, want, published, depth)
	}
}

func TestDroppedSubscriberSeesSequenceGapsAndHealthyOneDoesNot(t *testing.T) {
	b := stream.NewBroadcaster(4)

	slow := b.Subscribe(nil)
	defer slow.Close()
	fast := b.Subscribe(nil)
	defer fast.Close()

	// Lockstep again, so the healthy subscriber never overflows.
	var fastSeqs []uint64
	const batches = 50
	for i := 0; i < batches; i++ {
		b.Publish(allChannels())
		select {
		case batch := <-fast.C():
			fastSeqs = append(fastSeqs, batch.Sequence)
		case <-time.After(time.Second):
			t.Fatal("healthy subscriber received nothing")
		}
	}

	// The healthy subscriber sees an unbroken run.
	for i := 1; i < len(fastSeqs); i++ {
		if fastSeqs[i] != fastSeqs[i-1]+1 {
			t.Errorf("healthy subscriber saw a gap: %d then %d", fastSeqs[i-1], fastSeqs[i])
		}
	}

	// The starved one sees only the tail, so its first sequence is far past 1.
	var slowSeqs []uint64
	for len(slow.C()) > 0 {
		slowSeqs = append(slowSeqs, (<-slow.C()).Sequence)
	}
	if len(slowSeqs) == 0 {
		t.Fatal("slow subscriber buffered nothing")
	}
	if slowSeqs[0] <= 1 {
		t.Errorf("slow subscriber's first sequence is %d; expected a gap from dropped batches", slowSeqs[0])
	}
}

// --- Fan-out -------------------------------------------------------------

func TestFanOutDeliversTheSameSequenceToEverySubscriber(t *testing.T) {
	b := stream.NewBroadcaster(8)

	subs := []*stream.Subscription{b.Subscribe(nil), b.Subscribe(nil), b.Subscribe(nil)}
	for _, s := range subs {
		defer s.Close()
	}

	for i := 0; i < 5; i++ {
		b.Publish(allChannels())
	}

	for i, s := range subs {
		for want := uint64(1); want <= 5; want++ {
			select {
			case batch := <-s.C():
				if batch.Sequence != want {
					t.Errorf("subscriber %d got sequence %d, want %d", i, batch.Sequence, want)
				}
			default:
				t.Fatalf("subscriber %d missing batch %d", i, want)
			}
		}
	}
}

func TestPublishReturnsTheAssignedSequence(t *testing.T) {
	b := stream.NewBroadcaster(4)
	for want := uint64(1); want <= 3; want++ {
		if got := b.Publish(allChannels()); got != want {
			t.Errorf("Publish returned %d, want %d", got, want)
		}
	}
}

// --- Channel filtering ---------------------------------------------------

func TestSubscriptionFiltersToRequestedChannels(t *testing.T) {
	b := stream.NewBroadcaster(4)

	sub := b.Subscribe([]string{"vibration", "fuel_flow"})
	defer sub.Close()

	b.Publish(allChannels())

	batch := <-sub.C()
	if len(batch.Channels) != 2 {
		t.Fatalf("got %d channels, want 2", len(batch.Channels))
	}
	got := map[string]bool{}
	for _, ch := range batch.Channels {
		got[ch.ChannelId] = true
	}
	if !got["vibration"] || !got["fuel_flow"] {
		t.Errorf("filtered batch has wrong channels: %v", got)
	}
}

func TestEmptyFilterMeansAllChannels(t *testing.T) {
	b := stream.NewBroadcaster(4)

	for _, sub := range []*stream.Subscription{b.Subscribe(nil), b.Subscribe([]string{})} {
		b.Publish(allChannels())
		batch := <-sub.C()
		if len(batch.Channels) != 4 {
			t.Errorf("got %d channels, want all 4", len(batch.Channels))
		}
		sub.Close()
	}
}

func TestUnknownChannelFilterYieldsNoChannels(t *testing.T) {
	b := stream.NewBroadcaster(4)
	sub := b.Subscribe([]string{"no_such_channel"})
	defer sub.Close()

	b.Publish(allChannels())

	batch := <-sub.C()
	if len(batch.Channels) != 0 {
		t.Errorf("got %d channels, want 0", len(batch.Channels))
	}
}

// --- Lifecycle -----------------------------------------------------------

func TestCloseRemovesSubscriberAndClosesChannel(t *testing.T) {
	b := stream.NewBroadcaster(4)

	sub := b.Subscribe(nil)
	if got := b.SubscriberCount(); got != 1 {
		t.Fatalf("subscriber count %d, want 1", got)
	}

	sub.Close()
	if got := b.SubscriberCount(); got != 0 {
		t.Errorf("subscriber count %d after Close, want 0", got)
	}

	// Publishing after Close must not panic on a closed channel.
	b.Publish(allChannels())

	if _, open := <-sub.C(); open {
		t.Error("subscription channel still open after Close")
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	b := stream.NewBroadcaster(4)
	sub := b.Subscribe(nil)

	sub.Close()
	sub.Close() // must not panic on a double close
}

func TestConcurrentPublishAndSubscribe(t *testing.T) {
	b := stream.NewBroadcaster(8)

	// The publisher runs until told to stop, so it gets its own WaitGroup —
	// waiting on it alongside the subscribers would deadlock.
	var pubWg, subWg sync.WaitGroup
	stop := make(chan struct{})

	pubWg.Add(1)
	go func() {
		defer pubWg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				b.Publish(allChannels())
			}
		}
	}()

	for i := 0; i < 20; i++ {
		subWg.Add(1)
		go func() {
			defer subWg.Done()
			sub := b.Subscribe(nil)
			<-sub.C()
			sub.Close()
		}()
	}

	subWg.Wait()
	close(stop)
	pubWg.Wait()

	if got := b.SubscriberCount(); got != 0 {
		t.Errorf("subscriber count %d after all closed, want 0", got)
	}
}
