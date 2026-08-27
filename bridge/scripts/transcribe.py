import argparse
import json
import sys

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--input', required=True)
    args = parser.parse_args()

    try:
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        segments, _ = model.transcribe(args.input, language='zh', vad_filter=True)
        transcript = ''.join(
            segment.text.strip()
            for segment in segments
            if isinstance(segment.text, str) and segment.text.strip()
        )
        print(json.dumps({'transcript': transcript}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(f'transcription failed: {type(error).__name__}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
