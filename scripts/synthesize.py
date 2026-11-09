"""Private stdin JSON -> framed mono s16 PCM on stdout. Never save the text/audio."""
import json
import struct
import sys

def main():
    from pathlib import Path
    import onnxruntime
    from piper import PiperVoice, PiperConfig, SynthesisConfig
    payload = json.loads(sys.stdin.buffer.read(20000))
    text = payload["text"]
    rate = payload["rate"]
    if not isinstance(text, str) or not 0 < len(text) <= 3100 or not 0.8 <= rate <= 1.3:
        raise ValueError("Invalid speech request")
    # Explicit CPU/thread limits avoid taking GPU memory from the local LLM.
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    with open(sys.argv[1] + ".json", encoding="utf-8") as config_file:
        config = PiperConfig.from_dict(json.load(config_file))
    voice = PiperVoice(config=config, session=onnxruntime.InferenceSession(
        sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"]),
        download_dir=Path(sys.argv[1]).parent)
    sample_rate = voice.config.sample_rate
    if sample_rate != 22050:
        raise ValueError("Unsupported voice format")
    sys.stdout.buffer.write(b"AUR1" + struct.pack("<II", sample_rate, 1))
    size = 0
    for chunk in voice.synthesize(text, syn_config=SynthesisConfig(length_scale=1 / rate)):
        if chunk.sample_rate != sample_rate or chunk.sample_width != 2 or chunk.sample_channels != 1:
            raise ValueError("Unsupported audio format")
        size += len(chunk.audio_int16_bytes)
        if size > sample_rate * 2 * 360:
            raise ValueError("Speech is too long")
        sys.stdout.buffer.write(chunk.audio_int16_bytes)
    sys.stdout.buffer.flush()

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Local speech synthesis failed.", file=sys.stderr)
        sys.exit(1)
