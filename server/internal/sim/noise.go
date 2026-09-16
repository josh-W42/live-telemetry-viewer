package sim

import "math"

// Noise here is derived by hashing, not drawn from a running PRNG.
//
// A stateful generator such as rand.Rand would make output depend on call
// order: Range(0,200) and Range(0,100)+Range(100,200) would disagree, because
// the second form draws from a stream that has already advanced. Hashing
// (seed, index, channel) makes every sample independently addressable, so any
// range can be regenerated at any time in any order. That is what lets the
// pump ask for an arbitrary window each tick, and what makes the
// reproducibility test meaningful.

// splitmix64 is a fast, well-distributed finalizer. It is the standard
// bootstrap mixer for PRNG state and is more than adequate as a sample hash.
func splitmix64(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}

// hash combines a seed, a sample index and a channel ordinal into one value.
func hash(seed, index int64, channel uint64) uint64 {
	h := splitmix64(uint64(seed))
	h = splitmix64(h ^ uint64(index))
	return splitmix64(h ^ channel)
}

// uniform maps a hash to [0, 1) using the top 53 bits, the most a float64 can
// represent exactly.
func uniform(h uint64) float64 {
	return float64(h>>11) / float64(uint64(1)<<53)
}

// gaussian returns a standard normal sample for (seed, index, channel) via the
// Box-Muller transform. Both uniforms come from the same hash chain, so the
// result stays a pure function of its inputs.
func gaussian(seed, index int64, channel uint64) float64 {
	h1 := hash(seed, index, channel)
	h2 := splitmix64(h1)

	u1 := uniform(h1)
	u2 := uniform(h2)

	// log(0) is -Inf; nudge away from the boundary.
	if u1 < 1e-12 {
		u1 = 1e-12
	}
	return math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
}
