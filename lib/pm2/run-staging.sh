#!/bin/bash

# Navigate to the intended path
cd /home/ds/Documents/drop-shot-streaming-scripts-ubuntu/ || exit 1

# Run the project
nvm use 22
npm run dev
