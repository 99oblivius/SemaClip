# SemaClip — Architecture v1

> **SemaClip** /ˈsɛməklɪp/ — from Greek *σῆμα* (sema: sign, signal, mark, token) + English *clip*. A clip found by reading the signals.

---

## 1. Philosophy

Every existing automatic clip tool reduces the problem to a single scalar: "how loud/exciting is this moment?" SemaClip rejects this. A clip-worthy moment is not an amplitude peak — it is a **semantic event** that exists in a multidimensional space where each axis has its own structure, its own detection logic, and its own relationship to signal strength.

A human editor does not scan for the loudest second and cut. They recognize *kinds* of moments — a joke lands here, a clutch happens there, an awkward silence breaks over there — and each kind has a different temporal signature, a different set of signals, and a different ideal clip boundary. SemaClip models this directly.

### Core Principles

1. **Multimodal independence.** Voice, chat, and audio are independent sensors measuring overlapping but distinct phenomena. They can corroborate or contradict; both patterns are informative. They are never fused into a single scalar before the moment type is understood.

2. **Multi-axis detection.** Moments are classified by *type* (hype, humor, skill, awkward, emotional, tension), not just *intensity*. Each axis has its own detector and its own definition of "good."

3. **Adaptive temporal segmentation.** Fixed window sizes are the original sin of this domain. The natural "splice" boundaries are where the semantic or emotional structure changes — and those boundaries vary from 4 seconds to 4 minutes depending on the content.

4. **Contextual, not absolute, scoring.** A moment is scored relative to what constitutes "exceptional" for its axis, for this streamer, in this regime, at this point in the stream. A top-2% humor moment should outrank a top-20% hype moment. During a dead-chat lull, moderate excitement is notable; during overtime, only the extraordinary registers.

5. **Online personalization.** The system forms a working model of the streamer from the first five minutes and continuously adapts. It learns from implicit feedback — what the streamer self-labels, what chat sustains, what draws lurkers in. Every stream makes the system better for the next one.

6. **Clip boundaries are dynamic.** The end of a clip is not a fixed offset from the peak. It is the minimum of the emotional recovery point (chat derivative approaches zero), the semantic boundary (streamer changes topic), and the axis-appropriate maximum.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                    INPUT LAYER                                    │
│  VOD file + Chat JSON + optional game events                      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              COLD START: PERSONA INITIALIZATION                    │
│  Game detection, speech analysis, chat size → persona embedding   │
│  → initial baselines, thresholds, axis weights                    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              ADAPTIVE TEMPORAL SEGMENTATION                        │
│  Multimodal change-point detection across:                        │
│  · Transcript topic boundaries (semantic drift)                   │
│  · Chat regime changes (velocity, sentiment, emote composition)    │
│  · Audio scene changes (speech, silence, music, game audio)       │
│  · Game state transitions (optional)                              │
│  → variable-length "regimes" with classified types                │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              UNIVERSAL STREAM ENCODER                              │
│  Fixed pretrained model. Window → embedding vector.               │
│  Game-agnostic. Format-agnostic. Language-agnostic.               │
│  Trained contrastively: similar moment types cluster in space     │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              ONLINE STATE TRACKING (Kalman Filter)                 │
│  Running baseline in embedding space.                             │
│  Detects regime shifts: game change, collab join, tilt.           │
│  Adapts all parameters continuously.                              │
│  Slow baseline updates, fast event detection.                     │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              ANOMALY DETECTION (Embedding Space)                  │
│  "Is this window unusually far from the baseline in some way?"    │
│  → axis-agnostic candidate moments                                │
│  Distinction from baseline = potential significance               │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              LLM SEMANTIC TRIAGE (Local 7B)                       │
│  Candidates only. Classify: what type of moment? Clip-worthy?     │
│  → Axis classification + quality judgment                         │
│  → Filters anomalies that aren't good (glitches, false positives) │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              PER-AXIS SCORING + CONTEXTUAL CALIBRATION            │
│  Each axis detector scores candidates within their regime         │
│  Within-regime percentile: "how exceptional for this context?"    │
│  Scale amplification: truly extraordinary outliers boosted        │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              CROSS-AXIS RANKING + DIVERSITY CONSTRAINT            │
│  Axis-relative ranking: top-K from each axis's distribution       │
│  Diversity penalty prevents single-axis domination                │
│  → final ranked clip list with per-clip justification             │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              AXIS-SPECIFIC ENDPOINT RESOLUTION                    │
│  Each clip type has its own endpoint logic.                       │
│  t_end = min(axis_recovery, topic_boundary, axis_max_length)      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              IMPLICIT FEEDBACK EXTRACTION                         │
│  Streamer self-labels, chat persistence, lurker activation.       │
│  → Updates persona model for this streamer                        │
│  → Improves next stream's detection                               │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Moment Axes

SemaClip detects moments on six independent axes. A moment may score highly on one or several axes simultaneously. Detection is *disjunctive* — a moment is a candidate if it clears the threshold on *any* axis.

### 3.1 Hype

The classic "pop-off" moment. Aligned excitement across modalities.

| Signal | Pattern | Detector |
|--------|---------|----------|
| Audio | Volume spike, pitch increase | RMS + prosodic analysis |
| Chat | Velocity burst, POGGERS/OMEGALUL emote density | Per-second velocity + emote classifier |
| Voice | Faster speech, higher pitch, excitement markers | Prosodic deviation from baseline |
| Structure | Sharp onset, exponential-ish decay | Derivative-based peak + recovery detection |

**Endpoint**: Recovery when chat derivative → 0 AND voice pitch returns to baseline.

**False positive risk**: Gunshots, explosions, bass drops in game audio. Mitigated by VAD to distinguish voice excitement from game noise, and by requiring multi-signal corroboration during noisy regimes.

### 3.2 Humor

Jokes. Dirty jokes. Puns. Chat bait. Streamer cracking up at their own mistake. The key structural feature is the **setup → punchline gap → laughter** arc.

| Signal | Pattern | Detector |
|--------|---------|----------|
| Audio | Silence or deadpan → laughter burst | Laughter detector (pretrained audio classifier) |
| Chat | KEKW/LULW/💀 emote cluster after a gap | Emote density spike with temporal structure |
| Voice | Streamer goes silent (punchline delivery) → cracks up | Speech-to-laughter transition |
| Transcript | Setup structure identified by LLM | Candidate triage classifies setup → punchline arcs |

**Endpoint**: Last laugh + brief recovery. Must include the setup or the clip is worthless.

**Critical**: Humor is NOT amplitude-driven. The setup may be quiet. The punchline gap may be silence. Detection must look for the *structure*, not the intensity.

### 3.3 Skill

Pure gameplay excellence. Often the streamer is locked in and silent. Chat is sparse. Audio is game noise. This is the hardest axis.

| Signal | Pattern | Detector |
|--------|---------|----------|
| Chat | "HOW", "????", "SHEEEEESH", "clean", slow-building awe | Low-velocity, high-intensity reaction patterns |
| Voice | Quiet focus → release callout ("LET'S GO") | Speech rate drop → spike |
| Game events | Aces, clutches, multikills (game-dependent) | Plugin architecture: per-game detectors (OCR on kill feed, match data APIs) |
| Embedding | Anomalous in skill dimension of embedding space | Universal encoder's skill-proximity scoring |

**Endpoint**: Play completion + reaction window. For clutch moments, the tension build is part of the clip.

### 3.4 Awkward

Moments of negative space that become funny. Failed jokes, embarrassing plays, accidental mutes. The pattern is: **event → silence → sparse awkward reactions → release/eruption**.

| Signal | Pattern | Detector |
|--------|---------|----------|
| Chat | Normal velocity → sudden drop → "..." / "💀" / single reactions → eruption | Change-point detection on chat velocity + sentiment |
| Voice | Streamer stops talking → nervous laugh → "well then" / "anyway" | Silence detection + semantic recovery markers |
| Structure | Three-act: setup → silence → break → release | Sequential pattern matching across modalities |

**Endpoint**: After the release/eruption completes + topic shift.

### 3.5 Emotional

Donation thank-yous, heartfelt moments, community appreciation. Slow rise, slow decay. Often low or negative in the "excitement" dimension.

| Signal | Pattern | Detector |
|--------|---------|----------|
| Chat | Hearts, "aww", donation alerts, low velocity but high sentiment | Sentiment analysis with valence (not just intensity) |
| Voice | Softer, slower, pitch variation downward | Prosodic deviation (different direction than hype) |
| Transcript | Gratitude, personal stories, vulnerability markers | LLM classification of emotional content |

**Endpoint**: Natural conversational close. Longer clips acceptable here — emotional moments need room.

### 3.6 Tension

Sustained moderate signal with no release. Clutch situations. Final circles. Speedrun PBs. The moment isn't the spike — the moment is the sustained pressure.

| Signal | Pattern | Detector |
|--------|---------|----------|
| Chat | Fast, clipped messages: "CLUTCH" "PLEASE" "NO" "OMG" | Sustained velocity without large emote spikes |
| Voice | Fast speech rate, no laughter, high information density | Prosodic tension markers |
| Game state | Close score, low time, high stakes | Game-specific detectors |
| Structure | Sustained moderate elevation → sharp release | Plateau detection + release event |

**Endpoint**: The release. The clutch succeeds or fails. The round ends. The PB timer stops. The clip is the entire tension arc.

---

## 4. Adaptive Temporal Segmentation

### 4.1 Why Fixed Windows Fail

Existing tools hardcode windows (10s, 30s, 60s). This guarantees failure in one of two directions:

- Too short: cuts mid-joke, mid-clutch, mid-sentence.
- Too long: includes dead air, dilutes the moment, produces bloated clips.

The correct window is a function of the content structure. A joke is 18s. A Valorant round is 120s. A quick reaction is 4s. The window follows the content — not the other way around.

### 4.2 Change-Point Detection

For each modality, we detect distributional shifts in the signal using Bayesian change-point detection with a prior hazard rate. A unified boundary set merges candidates across modalities — a regime boundary exists where two or more modalities agree a transition occurred.

```python
# Chat regime features (per second):
# [msg_velocity, emote_density, unique_users, avg_msg_length, caps_ratio]

# Audio scene features (per second):
# [speech_probability, music_probability, rms_energy, spectral_centroid]

# Transcript features (per sentence):
# [sentence_embedding, sentiment_score, words_per_second]

# Change-point detection on the joint feature space
# Prior: regime change expected ~every 5 minutes (hazard_rate = 1/300)
change_points = bayesian_changepoint_detection(
    joint_features,
    hazard_rate=1/300,
    min_segment_length=10  # seconds
)
```

### 4.3 Regime Classification

Each segment is classified into a regime type, which affects how moments are scored within it:

| Regime | Characteristics | Baseline Behavior |
|--------|----------------|-------------------|
| Gameplay | Game audio dominant, streamer focused | Higher noise floor for audio; voice signal less reliable |
| Chatting | Streamer talking, game secondary | Voice signal primary; chat engagement expected |
| Hype | Sustained excitement, multi-signal alignment | Higher baseline for hype axis; threshold must adapt upward |
| Lull | Queue time, loading screens, breaks | Low baseline; moderate signals become notable |
| Collab | Multiple speakers, different dynamics | Speech patterns shift; chat responds to guest |
| Tilt | Negative sentiment, frustration | Distinguish tilt from hype (both are high-intensity, opposite valence) |

---

## 5. Universal Stream Encoder

### 5.1 Purpose

The encoder maps any stream window — regardless of game, format, language, or number of participants — to a fixed-size embedding vector. The embedding space has the property that moments of similar *type* cluster together, even if their surface features differ radically.

- `distance(Valorant ace, CS2 clutch)` is SMALL — both are skill moments
- `distance(Valorant ace, Minecraft build)` is LARGE — different moment types
- `distance(funny joke EN, funny joke JP)` is SMALL — both are humor moments
- `distance(solo hype, collab hype)` is SMALL — both are hype moments

### 5.2 Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Audio    │    │Transcript│    │  Chat    │
│ Encoder  │    │ Encoder  │    │ Encoder  │
│ (CLAP/   │    │ (sentence│    │ (Twitch- │
│  W2V2)   │    │ -transf) │    │  tuned)  │
└────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │
     ▼               ▼               ▼
┌─────────────────────────────────────────┐
│          Cross-Modal Attention           │
│  "Is chat reacting to what the streamer │
│   said 3 seconds ago?"                  │
│  Learns inter-modal relationships        │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│          Temporal Encoder                │
│  How does this window relate to what     │
│  came before? (causal attention)         │
└────────────────────┬────────────────────┘
                     │
                     ▼
              ┌──────────┐
              │ Embedding│
              │  Vector  │
              └──────────┘
```

### 5.3 Training

Trained contrastively on a corpus of public Twitch clips (labeled by clip title, view count, and community engagement metrics as weak supervision) plus VODs with chat. The model learns that moments which humans clipped, watched, and shared share properties in embedding space — regardless of what game they came from.

The encoder is frozen at inference time. It is the one component that requires one-time pretraining before shipping. All personalization happens downstream in the Kalman filter and axis detectors.

---

## 6. Online State Tracking

### 6.1 Why a Kalman Filter

The stream's "state" is not stationary. The baseline excitement level drifts over hours. A collab partner joins and the speech dynamics shift. The streamer tilts and the sentiment baseline inverts. The system must track these changes continuously, adapting all downstream parameters.

A Kalman filter is the natural choice because it:

- Maintains a running state estimate with quantified uncertainty
- Updates slowly for baseline parameters (a single spike doesn't change the baseline)
- Updates quickly for event detection (a spike is detected immediately)
- Naturally handles the exploration/exploitation tradeoff via the Kalman gain (high uncertainty → trust new observations more → faster adaptation)

### 6.2 State Vector

```
state = [
    # Per-axis baselines
    hype_baseline, humor_baseline, skill_baseline,
    awkward_baseline, emotional_baseline, tension_baseline,

    # Streamer characteristics
    speech_rate_baseline, pitch_baseline, pitch_variance_baseline,
    vocabulary_diversity, sentiment_mean,

    # Chat characteristics
    chat_velocity_baseline, active_chatters, emote_density_baseline,

    # Axis importance (streamer-specific)
    hype_weight, humor_weight, skill_weight, awkward_weight,
    emotional_weight, tension_weight,

    # Regime state
    current_regime_type, time_in_regime, energy_level,
]
```

### 6.3 Observation Model

Each new window of stream data produces an observation. The Kalman filter updates the state with a gain proportional to how informative the observation is:

```python
gain = uncertainty / (uncertainty + observation_noise)

# Baseline components adapt slowly
state.baseline += gain * 0.1 * (observation - prediction)

# Event scores adapt quickly (they're meant to)
state.event_score = observation - state.baseline
```

### 6.4 Regime Shift Detection

When the Kalman innovation (difference between prediction and observation) exceeds a threshold consistently across multiple modalities, a regime shift is declared. The state is partially reset (higher uncertainty → faster adaptation) and the new regime type is classified.

---

## 7. Per-Axis Detection

### 7.1 Chat Excitement Signal

The chat excitement signal `E(t)` is a per-second composite:

```
E(t) = α · msg_velocity_norm(t) + β · emote_density(t) + γ · caps_ratio(t) + δ · sentiment(t)
```

Where:
- `msg_velocity_norm(t)` = messages per second, normalized by active chatters
- `emote_density(t)` = weighted sum of excitement emotes (POGGERS > LUL > ResidentSleeper)
- `caps_ratio(t)` = proportion of ALL-CAPS characters in messages
- `sentiment(t)` = transformer-based sentiment score (positive excitement, not just volume)

The weights `[α, β, γ, δ]` are initialized from the persona model and adapted by implicit feedback.

### 7.2 Contextual Message Classification

Individual messages are classified using a three-layer context system:

1. **Base classification**: DistilBERT fine-tuned on Twitch chat → PRIMARY_INTENT (REACTION, GREETING, SOCIAL, HYPE, QUESTION)
2. **Temporal clustering**: Is this message part of a burst? What's the message density in a ±3s window relative to the local baseline?
3. **Neighbor amplification**: Does the surrounding discourse amplify or dampen this message's signal? A lone "yooo" in dead chat gets dampened; a "yooo" in a hype cluster gets amplified.

This handles the "yooo" disambiguation problem: a greeting and a reaction look similar lexically, but their temporal context differs. Greetings are uniformly distributed. Reactions cluster around events.

### 7.3 Voice Context Boundary Detection

Topic boundaries in the transcript are detected via embedding drift:

1. Transcribe with faster-whisper → word-level timestamps
2. Slide a 3-sentence window, compute sentence embeddings (all-MiniLM-L6)
3. Compute cosine similarity between adjacent windows
4. A topic boundary occurs where similarity drops below a threshold

The topic boundary after a highlight is the streamer's natural "we're done with that moment" signal — "anyway," "alright," "so yeah," "let's move on" — plus the underlying semantic shift that the embedding drift captures.

### 7.4 Signal Reliability Weighting

Each signal's contribution is a function of its local information density, not a fixed weight:

```python
def signal_weights(window):
    # Chat reliability
    chat_density = len(window.messages) / max(1, window.active_chatters)
    chat_diversity = len(set(m.author for m in window.messages))
    chat_reliability = min(1.0, chat_density * log(chat_diversity + 1))
    
    # Voice reliability
    speech_ratio = sum(seg.duration for seg in window.transcript) / window.duration
    voice_reliability = speech_ratio
    
    # Normalize
    total = chat_reliability + voice_reliability
    if total < EPSILON:
        return 0.0, 0.0  # dead zone — skip
    return chat_reliability / total, voice_reliability / total
```

This naturally handles VTubers with 5 lurkers (chat → 0, voice carries everything), locked-in competitive players (voice → 0, chat carries everything), and aligned excitement (both contribute).

### 7.5 Multi-Timescale Baseline

The threshold for "exceptional" is the **maximum** of two baselines:

```
threshold = max(local_baseline, global_baseline * 0.5)
```

- `local_baseline` = sliding 30-minute window median — adapts to the streamer's current mood
- `global_baseline` = full VOD median — prevents the local baseline from drifting so high during sustained hype that genuine moments are missed

The global floor at 0.5× ensures that even during a hype regime, a moment 50% above the overall stream's excitement level will still register. It anchors the system to the stream's true character.

---

## 8. Endpoint Resolution

### 8.1 The Recovery Principle

The end of a clip is not a fixed duration from the peak. It is the point where the emotional/semantic structure resolves:

```python
def find_endpoint(moment, axis):
    t_peak = moment.argmax
    
    # 1. Derivative-based recovery: chat has cooled down
    t_recovery = find_recovery(chat_signal, t_peak)
    # |E'(t)| < ε AND |E''(t)| ≈ 0 → emotional decay has leveled off
    
    # 2. Transcript topic boundary: streamer changed subject
    t_context = first_topic_shift_after(transcript_boundaries, t_peak)
    
    # 3. Axis-specific maximum
    t_max = axis_max_durations[axis]
    
    t_end = min(t_recovery, t_context + padding, t_peak + t_max)
    
    # 4. Don't cut mid-sentence
    t_end = snap_to_sentence_boundary(transcript, t_end)
    
    return t_end
```

The `min()` is the key: the clip ends when EITHER chat recovers OR the streamer changes topic OR the axis maximum is reached — whichever comes first.

### 8.2 Per-Axis Maximums

| Axis | Max Duration | Rationale |
|------|-------------|-----------|
| Hype | 45s | Most hype events resolve quickly |
| Humor | 60s | Setup + punchline + laughter needs room |
| Skill | 120s | Clutch rounds take time |
| Awkward | 45s | The awkwardness is the point; don't drag |
| Emotional | 120s | Gratitude needs space |
| Tension | 180s | The pressure is the content |

These are soft maximums, overridden by semantic boundaries.

---

## 9. Ranking & Diversity

### 9.1 Axis-Relative Scoring

Each moment's score is relative to its axis distribution, not absolute:

```python
def combined_score(moment, all_moments):
    axis_moments = [m for m in all_moments if m.axis == moment.axis]
    percentile = rank(moment.intensity, axis_moments) / len(axis_moments)
    
    z_score = (moment.intensity - mean(axis_moments)) / std(axis_moments)
    
    # Percentile ranking + magnitude amplification for true outliers
    return percentile * (1 + max(0, z_score) * 0.1)
```

A top-2% humor moment outranks a top-20% hype moment. But a once-in-a-stream hype moment (4σ above mean) gets a 40% boost and can still claim the top spot.

### 9.2 Diversity Constraint

Final output guarantees representation across axes:

```
Phase 1: Guarantee minimum slots per axis (at least 1)
Phase 2: Fill remaining slots from global ranking
Phase 3: Apply mild diversity penalty (cumulative per-axis count × 0.02)
```

The output for a 4-hour Valorant stream might be:

```
1. Skill   — Ace clutch 1v5         (0.98)
2. Humor   — Streamer makes bad pun  (0.95)
3. Hype    — Round-winning flick     (0.93)
4. Awkward — Failed knife, silence   (0.90)
5. Emotional — Donation thank-you    (0.87)
6. Hype    — Another great round     (0.86)
7. Skill   — Clean 4K               (0.83)
8. Humor   — Chat baits streamer    (0.82)
```

Every axis gets at least one slot. The awkward moment (#4) has a low raw intensity score but ranks at the 99th percentile of its axis — it's the most awkward moment in the stream. The diversity penalty prevents hype from dominating, but genuinely exceptional hype moments still claim multiple slots.

---

## 10. Implicit Feedback

### 10.1 Signals

The system never asks "was this a good clip?" It observes behavior that *reveals* whether it was:

| Signal | Weight | Evidence |
|--------|--------|----------|
| Streamer self-label | 1.0 | "that's the clip," "highlight that," "going on YouTube" |
| Streamer retrospective | 0.8 | References the moment later in the same stream |
| Extended chat reaction | 0.6 | Reaction persists 2× longer than expected for this axis/intensity |
| Lurker activation | 0.7 | First-time chatters appear during this moment |
| Streamer clipped it | 1.0 | A Twitch clip exists at this timestamp |
| Cross-stream reference | 0.9 | Referenced in future streams (requires multi-stream memory) |
| Sentiment arc | 0.5 | Redemption arc: negative → positive sentiment shift |
| Viewer count spike | 0.8 | Audience grew during this moment (from Twitch API if available) |

### 10.2 Feedback Loop

Each stream produces hundreds of implicit labels. After processing N streams for the same streamer:

1. The persona model is fine-tuned with the streamer's implicit labels
2. Axis importance weights shift to reflect which types of moments the streamer values
3. Detection thresholds calibrate to the streamer's personal "clip-worthy" bar

The system starts generic and becomes personal. A streamer who never clips hype but always clips humor will see their system shift toward humor detection within 3-5 streams.

---

## 11. Component Stack

### 11.1 Models & Libraries

| Component | Technology | Notes |
|-----------|-----------|-------|
| Audio transcription | faster-whisper (large-v3) | Word-level timestamps, runs on GPU |
| Audio event detection | CLAP / Wav2Vec2 | Pretrained audio encoder |
| Laughter detection | Pretrained laughter classifier | Fine-tuned on speech-laughter datasets |
| Sentence embeddings | all-MiniLM-L6-v2 | 80MB, CPU-friendly |
| Chat sentiment | DistilBERT fine-tuned on Twitch chat | 30-min fine-tuning job on labeled chat corpus |
| LLM triage (local) | Qwen 2.5 7B or Llama 3.1 8B | ~80 tok/s on 4090, ~2 min per VOD |
| Persona encoder | Custom contrastive model | Trained once on diverse stream corpus |
| Universal stream encoder | Custom multimodal encoder | Frozen at inference, pretrained on Twitch corpus |
| Chat parsing | TwitchDownloader | JSON export from VODs |
| Video processing | FFmpeg | Clip cutting, watermarks, format conversion |
| Numerical | NumPy, SciPy, scikit-learn | Signal processing, Kalman, statistics |

### 11.2 Runtime Estimates (4-hour VOD, RTX 4090)

| Phase | Time | Notes |
|-------|------|-------|
| Audio extraction + transcription | ~8 min | faster-whisper large-v3, GPU |
| Chat parsing | ~30s | TwitchDownloader |
| Adaptive segmentation | ~1 min | Change-point detection, CPU |
| Embedding extraction | ~4 min | Universal encoder, GPU |
| LLM triage (candidates) | ~2 min | ~200 candidates × 200 tokens each |
| Per-axis scoring | ~1 min | CPU |
| Endpoint resolution + export | ~1 min | FFmpeg |
| **Total** | **~17 min** | Mostly automated |

---

## 12. Anti-Goals (v1)

Things we are explicitly NOT building in v1:

- **Real-time live stream processing.** V1 is post-hoc VOD analysis. Live processing introduces fundamentally different latency and accuracy constraints.
- **Automatic social media publishing.** Export clips locally. What you do with them is your business.
- **Game-specific visual detectors (v1).** The plugin architecture exists for them, but v1 ships with universal signals only. Per-game detectors are v2.
- **Training the universal encoder ourselves in v1.** Architecture is defined; pretraining requires the corpus pipeline which is a separate project. V1 uses the architecture with a bootstrapped initialization.
- **Multi-streamer support in a single instance.** One streamer per installation. The persona model is per-streamer.
- **A web UI.** V1 is CLI + Python library. The UI belongs to the application layer, not the detection engine.

---

## 13. File Structure

See [STACK.md](STACK.md) for the complete technology stack. The project uses a
three-way split: `frontend/` (SvelteKit), `server/` (Deno backend), and
`engine/` (Python ML), with `shared/` for TypeScript types.

```
SemaClip/
├── frontend/                     # SvelteKit SPA (Svelte 5 + Tailwind + GSAP)
│   ├── src/
│   │   ├── routes/               # SvelteKit routes (SPA mode)
│   │   ├── lib/
│   │   │   ├── components/        # Timeline, VideoPlayer, ClipCard, etc.
│   │   │   ├── stores/           # Svelte stores (job progress, player state)
│   │   │   ├── api/              # TanStack Query client
│   │   │   └── actions/          # GSAP use:action directives
│   └── static/
├── server/                       # Deno backend (Deno Desktop + CEF)
│   ├── deno.json                 # Deno config + desktop config
│   ├── main.ts                   # Entry: window creation, server start
│   ├── api/                      # REST API routes
│   ├── ws/                       # WebSocket handler (progress streaming)
│   ├── python/                   # Python subprocess manager
│   └── db/                       # SQLite + Drizzle ORM schema + migrations
├── engine/                       # Python ML engine (PyInstaller binary)
│   ├── engine.py                 # Entry point (stdin/stdout IPC)
│   ├── semaclip/
│   │   ├── engine.py             # Main pipeline orchestrator
│   │   ├── persona.py            # Cold-start persona model
│   │   ├── segmentation.py       # Adaptive temporal segmentation
│   │   ├── encoder.py            # Universal stream encoder
│   │   ├── kalman.py             # Online state tracking
│   │   ├── axes/                 # Per-axis detectors (hype, humor, skill, ...)
│   │   ├── chat.py               # Chat parsing, classification, excitement signal
│   │   ├── voice.py              # Voice analysis: prosody, topic boundaries
│   │   ├── audio.py              # Audio scene analysis
│   │   ├── endpoints.py          # Endpoint resolution logic
│   │   ├── ranking.py            # Cross-axis ranking + diversity
│   │   ├── feedback.py           # Implicit feedback extraction
│   │   ├── export.py             # FFmpeg clip export
│   │   └── config.py             # Configuration, defaults, persistence
│   ├── pyproject.toml
│   └── requirements.txt
├── shared/                       # Shared TypeScript types (frontend + backend)
│   └── types.ts
├── data/                         # VODs and chat transcripts (gitignored)
│   ├── training/                 # Streams for development and calibration
│   └── testing/                  # Held-out streams for evaluation only
├── ARCHITECTURE.md               # ML pipeline architecture (this document)
├── STACK.md                      # Technology stack decisions
├── README.md
└── .gitignore
```
---

## 14. Open Questions for v2

- **Cross-stream memory**: Should the system maintain long-term memory of what made good clips across streams? If a moment from stream #5 was referenced in stream #12, that's a strong signal — but it requires a database and multi-stream analysis.
- **Live mode**: Real-time inference during the stream, feeding candidates to the streamer or a mod for instant clipping. Changes the compute budget and latency constraints entirely.
- **Visual game-state detection**: OCR on kill feeds, HUD element detection, game-specific event APIs. The plugin architecture exists but the plugins don't.
- **Editor-in-the-loop explicit feedback**: A review UI where the streamer marks clips as keep/discard, providing stronger labels than implicit signals.
- **Collaborative filtering**: If streamer A's community loves humor moments and streamer B has a similar community, can we transfer preferences?
