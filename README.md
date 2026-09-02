# oc2token

A macOS-first terminal dashboard for recorded token usage from OpenCode 2.

## Install

```sh
npm install -g oc2token
```

OpenCode 2's local service must be available to report usage. The beta API is
subject to change.

## Usage

```sh
oc2token                 # interactive dashboard; refreshes every 5 minutes
oc2token hour            # start on the rolling hour view
oc2token day             # start on today's local-calendar view
oc2token week            # start on the ISO-week view
oc2token --once --json   # one-shot machine-readable output
oc2token --refresh 0     # manual-only dashboard
oc2token doctor          # diagnose the local OpenCode 2 service
```

Press `r` to refresh, `1`/`2`/`3` to select hour/day/week, `?` for help, and
`q` to quit. Use `--timezone Europe/Istanbul` to override the local timezone.

The report calls the sum of input, output, reasoning, cache-read, and
cache-write tokens `recorded_total`; it is not a billing or quota total. A
filtered stats response is range-validated. If OpenCode 2 ignores the range,
`oc2token` falls back to paginated assistant-message aggregation rather than
labeling all-time usage as a filtered window.

## Development

```sh
npm install
npm test
npm run typecheck
npm run pack:check
```

OC2Token stores only normalized usage metadata in its own cache. It does not
persist prompts, tool input, API keys, or session titles.
