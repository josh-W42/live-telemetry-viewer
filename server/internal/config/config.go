// Package config reads deployment settings from the environment.
//
// Flags remain the interface for local development, where they are what a
// person types. The environment wins when it is set, because a platform
// injects PORT and has no way to pass a flag.
package config

import (
	"os"
	"strconv"
	"strings"
)

// String returns the environment value for key, or fallback when it is unset
// or blank.
//
// Blank counts as unset. A platform that exports every declared variable
// whether or not it was given a value would otherwise erase every default at
// once, and the surrounding space is trimmed because a value pasted into a
// dashboard field often carries some.
func String(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// Int is String for whole numbers.
//
// A malformed value falls back rather than failing the boot: a service that
// refuses to start because one non-critical setting has a typo in it is an
// outage, where carrying on with the default is a slightly wrong number. An
// explicit 0 is kept, since zero is meaningful for at least one setting here.
func Int(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}

	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
