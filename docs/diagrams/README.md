# Animated SlateDB Metadata Architecture

Open [the interactive diagram](slatedb-metadata-architecture.html) in a browser. It is a
self-contained, offline illustration of [the architecture reference](../slatedb-metadata-design.md).
It does not connect to the running product or change any service state. GitHub shows the HTML
source; download/open the file or serve this directory locally to play it:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory docs/diagrams
```

[Download the looping GIF](slatedb-metadata-architecture.gif) for sharing, or view the
[static preview](slatedb-metadata-poster.png). The GIF is 1280 × 960, 30 seconds, 10 fps
and approximately 514 KiB. Its 300 frames play the interactive timeline at 1.2 times speed
and loop continuously. The file is below [X's documented 5 MB mobile GIF limit](https://help.x.com/en/using-x/posting-gifs-and-pictures).

The control arrows show the issuer of a command. In the current transport, Region opens the authenticated connection and Global sends commands on it. See [ADR 0043](../decisions/0043-portal-agent-region-control.md).

## Visual treatment

The viewer should remember that each authority has its own durable metadata boundary and
regional serving does not require a Global round trip. Keep the architecture's objects in
place while requests, persistence and failure change their state. The animation uses a
charcoal stage, blue requests, amber pending/unavailable state and green durable responses.
Text and line patterns reinforce the colors.

The 36-second illustrative timeline has three chapters:

| Time    | Trigger and visible consequence                                                                                   | Hold                          |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 0–12 s  | A regional metadata mutation reaches repositories, Meta and S3; a durable response returns only after persistence | ACK follows object durability |
| 12–24 s | Global persists intent, initiates a regional command and then an observation read; Region replies to those calls  | Global issues policy commands |
| 24–36 s | Global becomes unavailable; direct authorized requests still traverse independent regional Meta/S3 paths          | Known regional work continues |

Global control is labeled planned. Command acceptance is distinct from provider completion.
The example assumes valid local regional authorization and available regional infrastructure;
its timing is illustrative. Customer SQL/file data uses the separate regional data-plane
branch, not the metadata persistence path.

## Interaction and rendering

Use chapter selection, Play/Pause, Next step, Replay or the timeline slider. Reduced-motion
preferences start the diagram paused. Narrow screens use a stacked layout with readable
labels. All assets are local code and system fonts; no network resources are required.

The page exposes `window.READY`, `window.DUR`, `window.render(t)`, `window.TEXTS(t)` and
`window.EV`. Pause playback before rendering inspection timestamps. The frame at a timestamp
is independent of earlier frames; node/edge identities remain stable within a layout.
Inspect the durable-response boundary, the planned command/query responses, Global outage,
keyboard controls, and desktop/narrow layouts when changing it.

The architecture is project-authored and based on the repository reference and its source
contracts. The timing is synthetic; no customer data, external artwork, audio or measured
performance is included. This is an interactive diagram, not a rendered video.
