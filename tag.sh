#!/bin/bash

# Usage: ./tag.sh v0.0.1

# Exit on error
set -e

function ask_for_tag() {
  read -p "Enter the tag name (e.g., v0.0.1): " TAG
}

function handle_existing_tag() {
  echo "Tag '$TAG' already exists."
  read -p "Do you want to delete and re-tag it? (y/n): " CONFIRM
  if [[ "$CONFIRM" == "y" ]]; then
    echo "Deleting existing tag..."
    git tag -d "$TAG"
    git push origin ":refs/tags/$TAG"
  else
    ask_for_tag
    check_and_tag  # Recursively restart the process with new tag
    exit 0
  fi
}

function check_and_tag() {
  if git rev-parse "$TAG" >/dev/null 2>&1; then
    handle_existing_tag
  fi

  echo "Tagging current commit with '$TAG'..."
  git tag "$TAG"
  git push origin "$TAG"
  echo "Tag '$TAG' has been created and pushed."
}

# Initial prompt and start
ask_for_tag
check_and_tag
