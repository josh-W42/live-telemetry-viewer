// Command server hosts the telemetry Connect service.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/josh-W42/live-telemetry-viewer/server/internal/config"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/sim"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/stream"
	"github.com/josh-W42/live-telemetry-viewer/server/internal/web"
)

func main() {
	// Defaults come from the environment, which is how a platform configures
	// a container; the flags remain what a person types locally.
	port := flag.String("port", config.String("PORT", "8080"), "port to listen on")
	rate := flag.Float64("rate", 1000, "samples per second per channel")
	seed := flag.Int64("seed", 1, "simulator seed, for reproducible runs")
	batchInterval := flag.Duration("batch-interval", 50*time.Millisecond, "how often to flush a batch")
	allowedOrigin := flag.String("allowed-origin",
		config.String("ALLOWED_ORIGIN", "http://localhost:5173"),
		"CORS origin for a cross-origin dev client; empty disables CORS entirely")
	maxSubs := flag.Int("max-subscribers",
		config.Int("MAX_SUBSCRIBERS", 25),
		"concurrent stream limit; 0 for unlimited")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// The simulator is pure, so the epoch is fixed once here. Everything
	// downstream derives timestamps from it.
	simCfg := sim.Config{
		Seed:    *seed,
		RateHz:  *rate,
		EpochNs: time.Now().UnixNano(),
	}
	simulator := sim.New(simCfg)

	bus := stream.NewBroadcasterWithLimit(stream.DefaultBufferDepth, *maxSubs)

	// One simulator feeds the broadcaster, so every browser tab sees the same
	// engine run. It starts at boot and keeps running with no subscribers, so
	// the test sequence stays on the wall clock.
	pump := stream.NewPump(simCfg, bus, *batchInterval)
	go pump.Run(ctx)

	go logStats(ctx, bus)

	srv := &http.Server{
		Addr:              ":" + *port,
		Handler:           stream.NewHTTPHandler(stream.New(simulator, bus, pump.Restart), *allowedOrigin, web.Handler()),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	log.Printf("telemetry server listening on %s (rate=%.0fHz seed=%d batch=%s loop=%s max-subs=%d cors=%q)",
		srv.Addr, *rate, *seed, *batchInterval, sim.LoopDuration(), *maxSubs, *allowedOrigin)

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server: %v", err)
	}
	log.Print("server stopped")
}

// logStats periodically reports subscriber and drop counts, so backpressure is
// visible from the server side without attaching a debugger.
func logStats(ctx context.Context, bus *stream.Broadcaster) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	var lastDropped uint64
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			subs := bus.SubscriberCount()
			if subs == 0 {
				continue
			}
			dropped := bus.Dropped()
			log.Printf("stream: subscribers=%d dropped=%d (+%d since last report)",
				subs, dropped, dropped-lastDropped)
			lastDropped = dropped
		}
	}
}
