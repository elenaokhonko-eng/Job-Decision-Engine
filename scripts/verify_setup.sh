#!/bin/bash

# Verification script for Job Decision Engine setup

echo "===================================================="
echo "          JOB DECISION ENGINE SETUP VERIFIER        "
echo "===================================================="

# Check if node is installed
if ! command -v node &> /dev/null
then
    echo "❌ ERROR: Node.js is not installed."
    exit 1
else
    echo "✅ Node.js: $(node -v) is available."
fi

# Check if npm is installed
if ! command -v npm &> /dev/null
then
    echo "❌ ERROR: npm is not installed."
    exit 1
else
    echo "✅ npm: $(npm -v) is available."
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "⚠️  WARNING: node_modules directory not found. Installing dependencies..."
    npm install
    if [ $? -eq 0 ]; then
        echo "✅ Dependencies installed successfully."
    else
        echo "❌ ERROR: Dependency installation failed."
        exit 1
    fi
else
    echo "✅ Dependencies: node_modules is populated."
fi

# Check for .env file
if [ ! -f ".env" ]; then
    echo "⚠️  WARNING: .env file does not exist. Creating from .env.example..."
    cp .env.example .env
fi

# Check for GEMINI_API_KEY in .env
if grep -q "GEMINI_API_KEY=\"MY_GEMINI_API_KEY\"" .env; then
    echo "⚠️  LOUD-FAIL ALERT: GEMINI_API_KEY in .env is set to the default placeholder."
    echo "   The Multi-Stage Decision Engine will FAIL LOUD upon first request until this is set."
    echo "   Please add your real Gemini API key in the Secrets panel in AI Studio or edit the .env file."
elif grep -q "GEMINI_API_KEY=" .env; then
    echo "✅ Environment: GEMINI_API_KEY is configured in .env."
else
    echo "❌ LOUD-FAIL ALERT: GEMINI_API_KEY is completely missing from .env."
    echo "   The engine will crash immediately on API request. Please configure it."
fi

echo "===================================================="
echo "Status check finished. Ready to compile and start!"
echo "===================================================="
