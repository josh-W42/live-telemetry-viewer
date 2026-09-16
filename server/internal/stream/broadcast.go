package stream

import (
	"sync"
	"sync/atomic"

	telemetryv1 "github.com/josh-W42/sift/server/gen/telemetry/v1"
)

// DefaultBufferDepth is how many batches a subscriber may fall behind before
// the broadcaster starts discarding its oldest.
//
// At a 50ms flush interval this is roughly 400ms of slack: enough to absorb a
// GC pause or a scheduling hiccup, short enough that a genuinely slow client
// stays close to live rather than drifting seconds behind. For live telemetry,
// lagging is worse than losing - old samples have no value once newer ones
// exist.
const DefaultBufferDepth = 8

// Broadcaster fans one simulator out to many subscribers.
//
// The central rule is that Publish never blocks. The simulator advances on a
// wall clock and cannot be held up by a browser tab that stopped reading, so a
// subscriber which cannot keep up loses data instead. Each batch carries a
// sequence number assigned here, which is what lets a client detect exactly
// that.
type Broadcaster struct {
	depth int

	mu   sync.Mutex
	subs map[*Subscription]struct{}
	seq  uint64
}

// NewBroadcaster returns a Broadcaster whose subscribers buffer depth batches.
// A depth below 1 falls back to DefaultBufferDepth.
func NewBroadcaster(depth int) *Broadcaster {
	if depth < 1 {
		depth = DefaultBufferDepth
	}
	return &Broadcaster{
		depth: depth,
		subs:  make(map[*Subscription]struct{}),
	}
}

// Subscription is one client's view of the stream.
type Subscription struct {
	ch      chan *telemetryv1.TelemetryBatch
	filter  map[string]struct{} // nil means every channel
	dropped atomic.Uint64

	closeOnce sync.Once
	b         *Broadcaster
}

// C returns the channel batches arrive on. It is closed by Close.
func (s *Subscription) C() <-chan *telemetryv1.TelemetryBatch { return s.ch }

// Dropped reports how many batches this subscriber lost to a full buffer.
func (s *Subscription) Dropped() uint64 { return s.dropped.Load() }

// Close unsubscribes and closes the batch channel. It is safe to call more
// than once.
func (s *Subscription) Close() {
	s.closeOnce.Do(func() {
		s.b.remove(s)
		// Removal happens under the same lock Publish holds, so no send can be
		// in flight here and closing the channel cannot panic.
		close(s.ch)
	})
}

// Subscribe registers a subscriber. An empty or nil channelIDs means all
// channels.
func (b *Broadcaster) Subscribe(channelIDs []string) *Subscription {
	var filter map[string]struct{}
	if len(channelIDs) > 0 {
		filter = make(map[string]struct{}, len(channelIDs))
		for _, id := range channelIDs {
			filter[id] = struct{}{}
		}
	}

	sub := &Subscription{
		ch:     make(chan *telemetryv1.TelemetryBatch, b.depth),
		filter: filter,
		b:      b,
	}

	b.mu.Lock()
	b.subs[sub] = struct{}{}
	b.mu.Unlock()

	return sub
}

func (b *Broadcaster) remove(sub *Subscription) {
	b.mu.Lock()
	delete(b.subs, sub)
	b.mu.Unlock()
}

// SubscriberCount returns the number of live subscribers.
func (b *Broadcaster) SubscriberCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

// Dropped returns the total batches dropped across all live subscribers.
func (b *Broadcaster) Dropped() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()

	var total uint64
	for sub := range b.subs {
		total += sub.Dropped()
	}
	return total
}

// Publish assigns the next sequence number and delivers the batch to every
// subscriber, returning the sequence used. It never blocks.
//
// The ChannelSamples pointers are shared across subscribers rather than copied.
// Nothing mutates them after publication, so this is safe and keeps fan-out to
// one small allocation per filtered subscriber.
func (b *Broadcaster) Publish(channels []*telemetryv1.ChannelSamples) uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.seq++
	seq := b.seq

	// Unfiltered subscribers all share one batch value.
	full := &telemetryv1.TelemetryBatch{Channels: channels, Sequence: seq}

	for sub := range b.subs {
		batch := full
		if sub.filter != nil {
			batch = &telemetryv1.TelemetryBatch{
				Channels: filterChannels(channels, sub.filter),
				Sequence: seq,
			}
		}
		sub.send(batch)
	}

	return seq
}

func filterChannels(channels []*telemetryv1.ChannelSamples, filter map[string]struct{}) []*telemetryv1.ChannelSamples {
	out := make([]*telemetryv1.ChannelSamples, 0, len(filter))
	for _, ch := range channels {
		if _, ok := filter[ch.ChannelId]; ok {
			out = append(out, ch)
		}
	}
	return out
}

// send delivers one batch without blocking, discarding the oldest buffered
// batch if there is no room.
//
// Called with the broadcaster's lock held, and the lock is also what protects
// against a concurrent Close, so the channel cannot be closed underneath us.
func (s *Subscription) send(batch *telemetryv1.TelemetryBatch) {
	select {
	case s.ch <- batch:
		return
	default:
	}

	// Buffer is full. Drop the head to make room for the newer batch. The
	// drain can lose its race with a reader that just took an item, in which
	// case the send below simply succeeds into the space they freed.
	select {
	case <-s.ch:
		s.dropped.Add(1)
	default:
	}

	select {
	case s.ch <- batch:
	default:
		// A reader refilled the buffer between the two operations. Dropping
		// the newest is the only option left, and it is still a drop.
		s.dropped.Add(1)
	}
}
