# speaker (peripheral)

Play notes, Minecraft sounds, or arbitrary streamed audio.

Source: https://tweaked.cc/peripheral/speaker.html

## Methods

- `playNote(instrument [, volume [, pitch]])` → `boolean` — play a noteblock note. Max 8 notes/tick (returns `false` if the limit is hit). Throws on unknown instrument.
  - `volume` 0.0-3.0 (default 1.0); `pitch` in semitones 0-24 (default 12). 0/12/24 = F#, 6/18 = C.
  - Instruments: `harp`, `basedrum`, `snare`, `hat`, `bass`, `flute`, `bell`, `guitar`, `chime`, `xylophone`, `iron_xylophone`, `cow_bell`, `didgeridoo`, `bit`, `banjo`, `pling`.
- `playSound(name [, volume [, pitch]])` → `boolean` — play a vanilla/modded sound id, e.g. `"entity.creeper.primed"` or `"minecraft:block.note_block.harp"`. Only one sound at a time; returns `false` if another sound started this tick or audio is still playing. `volume` 0.0-3.0; `pitch` 0.5-2.0.
- `playAudio(audio [, volume])` → `boolean` — stream raw PCM: a list of amplitudes -128..127, played at 48kHz. Returns `false` when the internal buffer is full — then wait for a `speaker_audio_empty` event before retrying. Only one `playAudio` call is buffered at a time, so send as many samples as possible per call (up to 128×1024) to avoid stutter.
- `stop()` — stop all audio on this speaker.

## Streaming audio pattern

Decode DFPWM with `cc.audio.dfpwm` and push chunks, waiting for the empty event:
```lua
local dfpwm = require("cc.audio.dfpwm")
local speaker = peripheral.find("speaker")
local decoder = dfpwm.make_decoder()
for chunk in io.lines("data/example.dfpwm", 16 * 1024) do
  local buffer = decoder(chunk)
  while not speaker.playAudio(buffer) do
    os.pullEvent("speaker_audio_empty")
  end
end
```

See also the guide: https://tweaked.cc/guide/speaker_audio.html
