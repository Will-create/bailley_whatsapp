#!/bin/bash

# Help menu
usage() {
  echo "Usage:"
  echo "  $0 video -u <url> [options]"
  echo "  $0 short -u <url> [options]"
  echo "  $0 playlist -u <url> [options]"
  echo
  echo "Options:"
  echo "  -u <URL>         YouTube URL"
  echo "  -d <directory>   Destination folder (default: ./downloads)"
  echo "  -a               Audio only"
  echo "  -t <template>    Filename template (yt-dlp style)"
  echo "  -i               Interactive format selection"
  echo "  -h               Show help"
  exit 1
}

# Defaults
DEST="downloads"
AUDIO_ONLY=false
INTERACTIVE=false
TEMPLATE=""
MODE=""

# --- Step 1: Detect main command ---
if [[ "$1" == "video" || "$1" == "short" || "$1" == "playlist" ]]; then
  MODE="$1"
  shift
else
  echo "❌ Error: You must specify a mode: video | short | playlist"
  usage
fi

# --- Step 2: Parse flags ---
while getopts ":u:d:at:ih" opt; do
  case $opt in
    u) URL="$OPTARG" ;;
    d) DEST="$OPTARG" ;;
    a) AUDIO_ONLY=true ;;
    t) TEMPLATE="$OPTARG" ;;
    i) INTERACTIVE=true ;;
    h) usage ;;
    \?) echo "Invalid option: -$OPTARG" >&2; usage ;;
    :) echo "Option -$OPTARG requires an argument." >&2; usage ;;
  esac
done

# --- Step 3: Validate URL ---
if [ -z "$URL" ]; then
  echo "❌ Error: URL is required."
  usage
fi

# --- Step 3.5: Normalize URL ---
# If user passed only an ID, build full URL depending on the mode
if [[ "$URL" =~ ^[a-zA-Z0-9_-]{11,}$ ]]; then
  case $MODE in
    video) URL="https://www.youtube.com/watch?v=$URL" ;;
    short) URL="https://www.youtube.com/shorts/$URL" ;;
    playlist) URL="https://www.youtube.com/playlist?list=$URL" ;;
  esac
fi


# --- Step 4: Prepare yt-dlp command ---
mkdir -p "$DEST"

CMD="yt-dlp -P \"$DEST\""

# Audio or Video
if [ "$AUDIO_ONLY" = true ]; then
  CMD+=" -f bestaudio --extract-audio --audio-format mp3"
else
  CMD+=" -f bestvideo+bestaudio --merge-output-format mp4"
fi

# Handle playlist mode
case $MODE in
  video|short)
    CMD+=" --no-playlist"
    ;;
  playlist)
    CMD+=" --yes-playlist"
    ;;
esac

# Interactive mode
if [ "$INTERACTIVE" = true ]; then
  CMD+=" -F"
  echo "🧠 Interactive format listing:"
  eval $CMD "\"$URL\""
  echo -n "🔢 Enter format code: "
  read -r FORMAT_CODE
  CMD="yt-dlp -P \"$DEST\" -f $FORMAT_CODE"
fi

# Custom filename
if [ -n "$TEMPLATE" ]; then
  CMD+=" -o \"$TEMPLATE\""
fi

# --- Step 5: Execute ---
echo "🚀 Downloading $MODE from $URL..."
eval $CMD "\"$URL\""

# Notify if available
if command -v notify-send &> /dev/null; then
  notify-send "Download Complete" "Your $MODE has been downloaded."
fi

echo "✅ Done."
