package stream

import (
	"errors"
	"sync"
	"sync/atomic"

	telemetryv1 "github.com/josh-W42/live-telemetry-viewer/server/gen/telemetry/v1"
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
	depth   int
	maxSubs int

	mu   sync.Mutex
	subs map[*Subscription]struct{}
	seq  uint64
}

// ErrTooManySubscribers is returned by Subscribe when the broadcaster is full.
var ErrTooManySubscribers = errors.New("too many subscribers")

// NewBroadcaster returns an uncapped Broadcaster whose subscribers buffer
// depth batches. A depth below 1 falls back to DefaultBufferDepth.
func NewBroadcaster(depth int) *Broadcaster {
	return NewBroadcasterWithLimit(depth, 0)
}

// NewBroadcasterWithLimit is NewBroadcaster with a ceiling on concurrent
// subscribers. A maxSubs of 0 means unlimited.
//
// The deployed endpoint is unauthenticated and streams roughly 68 KiB/s per
// subscriber - about 5.9 GB a day each. Without a ceiling, any visitor decides
// the egress bill.
func NewBroadcasterWithLimit(depth, maxSubs int) *Broadcaster {
	if depth < 1 {
		depth = DefaultBufferDepth
	}
	if maxSubs < 0 {
		maxSubs = 0
	}
	return &Broadcaster{
		depth:   depth,
		maxSubs: maxSubs,
		subs:    make(map[*Subscription]struct{}),
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

// Subscribe registers a subscriber, or returns ErrTooManySubscribers when the
// broadcaster is at capacity. An empty or nil channelIDs means all channels.
//
// One door rather than a separate capped variant: two ways to subscribe means
// a later caller can reach for the uncapped one without noticing, which is
// exactly the mistake the ceiling exists to prevent.
func (b *Broadcaster) Subscribe(channelIDs []string) (*Subscription, error) {
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
	defer b.mu.Unlock()

	if b.maxSubs > 0 && len(b.subs) >= b.maxSubs {
		return nil, ErrTooManySubscribers
	}
	b.subs[sub] = struct{}{}

	return sub, nil
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
// Published reports how many batches have been broadcast. Sequence numbers
// are assigned one per publish, so this is that counter.
func (b *Broadcaster) Published() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.seq
}

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
