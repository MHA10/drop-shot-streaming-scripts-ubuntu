#!/bin/bash

# Navigate to the intended path
cd /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/ || exit 1

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Run the project
nvm use 22
npm install
npm run dev
