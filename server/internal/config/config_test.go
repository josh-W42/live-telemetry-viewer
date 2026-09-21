package config_test

import (
	"testing"

	"github.com/josh-W42/live-telemetry-viewer/server/internal/config"
)

/*
The platform supplies PORT and has no way to pass a flag, so the environment
has to win over the flag's default. Flags stay the interface for local
development, where there is no environment to speak of.
*/
func TestStringPrefersTheEnvironment(t *testing.T) {
	t.Setenv("PORT", "10000")

	if got := config.String("PORT", "8080"); got != "10000" {
		t.Errorf("got %q, want the environment's 10000", got)
	}
}

func TestStringFallsBackToTheDefault(t *testing.T) {
	t.Setenv("PORT", "")

	if got := config.String("PORT", "8080"); got != "8080" {
		t.Errorf("got %q, want the fallback 8080", got)
	}
}

// An empty variable means "unset", not "set to empty". A platform that exports
// every declared variable whether or not it was given a value would otherwise
// erase every default at once.
func TestStringTreatsBlankAsUnset(t *testing.T) {
	t.Setenv("ALLOWED_ORIGIN", "   ")

	if got := config.String("ALLOWED_ORIGIN", "fallback"); got != "fallback" {
		t.Errorf("got %q, want the fallback", got)
	}
}

func TestStringTrimsSurroundingSpace(t *testing.T) {
	t.Setenv("PORT", "  10000  ")

	if got := config.String("PORT", "8080"); got != "10000" {
		t.Errorf("got %q; a value pasted into a dashboard often carries spaces", got)
	}
}

func TestIntParsesTheEnvironment(t *testing.T) {
	t.Setenv("MAX_SUBSCRIBERS", "40")

	if got := config.Int("MAX_SUBSCRIBERS", 25); got != 40 {
		t.Errorf("got %d, want 40", got)
	}
}

/*
A malformed value falls back rather than failing the boot. A service that
refuses to start because one non-critical setting has a typo in it is worse
than one that carries on with its default: the first is an outage, the second
is a slightly wrong number.
*/
func TestIntFallsBackOnSomethingUnparseable(t *testing.T) {
	t.Setenv("MAX_SUBSCRIBERS", "twenty five")

	if got := config.Int("MAX_SUBSCRIBERS", 25); got != 25 {
		t.Errorf("got %d, want the fallback 25", got)
	}
}

func TestIntFallsBackWhenUnset(t *testing.T) {
	t.Setenv("MAX_SUBSCRIBERS", "")

	if got := config.Int("MAX_SUBSCRIBERS", 25); got != 25 {
		t.Errorf("got %d, want the fallback 25", got)
	}
}

// Zero is a meaningful value elsewhere in this codebase - an unlimited
// subscriber cap - so it must survive rather than being mistaken for unset.
func TestIntKeepsAnExplicitZero(t *testing.T) {
	t.Setenv("MAX_SUBSCRIBERS", "0")

	if got := config.Int("MAX_SUBSCRIBERS", 25); got != 0 {
		t.Errorf("got %d; an explicit 0 means unlimited and must not fall back", got)
	}
}

/*
Found by running the container, not by a test.

render.yaml declares ALLOWED_ORIGIN as "" to mean "single origin, skip CORS".
Read through String, blank counts as unset and that silently became the
development default - so the deployed service would have carried a localhost
CORS policy while its config said otherwise.
*/
func TestStringAllowEmptyKeepsAnExplicitEmptyValue(t *testing.T) {
	t.Setenv("ALLOWED_ORIGIN", "")

	if got := config.StringAllowEmpty("ALLOWED_ORIGIN", "http://localhost:5173"); got != "" {
		t.Errorf("got %q; an explicitly empty origin means CORS off, not the default", got)
	}
}

func TestStringAllowEmptyStillFallsBackWhenAbsent(t *testing.T) {
	// No Setenv at all: the variable does not exist.
	if got := config.StringAllowEmpty("ORIGIN_NOT_SET_ANYWHERE", "fallback"); got != "fallback" {
		t.Errorf("got %q, want the fallback for a genuinely absent variable", got)
	}
}

func TestStringAllowEmptyTrims(t *testing.T) {
	t.Setenv("ALLOWED_ORIGIN", "  https://example.test  ")

	if got := config.StringAllowEmpty("ALLOWED_ORIGIN", "fb"); got != "https://example.test" {
		t.Errorf("got %q", got)
	}
}

// The contrast that makes the pair worth having: PORT has no meaningful empty
// value, so blank there still means unset.
func TestStringStillTreatsBlankAsUnset(t *testing.T) {
	t.Setenv("PORT", "")

	if got := config.String("PORT", "8080"); got != "8080" {
		t.Errorf("got %q, want the fallback", got)
	}
}
