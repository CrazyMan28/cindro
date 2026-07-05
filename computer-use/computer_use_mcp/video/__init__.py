"""Video understanding for Jarvis — perception, not interpretation.

Turns a local video file or YouTube URL into things the model can perceive:
frames (images with timestamps) and an audio transcription (timestamped text).
The model does the understanding; this package only extracts.

Layout:
  types.py        shared dataclasses (metadata, frames, transcription, analysis)
  timestamps.py   HH:MM:SS parsing/formatting + timeline re-anchoring
  platform_info.py OS/GPU/RAM detection, dependency checks, model recommendation
  config.py       settings bridge to jarvisd (video_* keys) + storage dirs
  video_source.py local-path validation + YouTube download/captions (yt-dlp API)
  frames.py       ffmpeg frame extraction (auto-fps, segments, formats)
  audio.py        ffmpeg audio extraction (16kHz mono WAV)
  audio_chunker.py silence-aligned chunk planning for long audio
  analyzers.py    one-pass ffmpeg structural analysis (scenes/silence/motion/...)
  backends/       transcription engines (faster-whisper default, cpp, CLIs, cloud)
  session/        frame cache keyed by video hash (enable_index)
"""
