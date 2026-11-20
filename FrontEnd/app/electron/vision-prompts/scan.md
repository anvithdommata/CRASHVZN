# Incident scan: {{from}} s to {{to}} s

Each video above is clipped to this window, at 3 frames per second. Your only job here is to find anything crash-like. Don't track normal traffic.

Watch **every camera** for the **whole window**. Crashes are brief: a contact can last half a second, then the aftermath is a vehicle turned sideways, debris on the road, a vehicle stopping in a running lane, or hazard lights. Look for the aftermath too, then work back to when it started.

Report an event for each of:

- **contact**: two vehicles touch, or a vehicle hits a barrier. Give the first-contact time.
- **spin**: a vehicle turns sideways or rotates against its lane.
- **swerve** or **hard_braking**: an abrupt evasive move or a nose-dive stop.
- **stopped_vehicle**: a vehicle stopping in a running lane (not in a queue that's already stopped).
- **debris** or **near_miss**: as named.

For each event:

- `t_s`: on the **full** timeline (this window starts at {{from}} s), to a tenth of a second.
- `camera`: the video's name as given above.
- `vehicles`: colour and type ("yellow sedan, white van").
- `lane`: e.g. "left lane next to the median, traffic moving toward the camera".
- `description`: one or two sentences.
- `confidence`: 0–1.

Only report what you can actually see. A secondary collision you only infer goes in at low confidence. Ordinary congestion (slow, evenly spaced queues) is not an event. If nothing happens, return an empty list.
