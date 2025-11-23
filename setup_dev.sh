#!/bin/bash

# ------------------------------------------------------------------------------
# MacOS Node.js & React Development Environment Setup Script
# ------------------------------------------------------------------------------
# This script installs:
# 1. Homebrew (The missing package manager for macOS)
# 2. Git (Version Control)
# 3. NVM (Node Version Manager)
# 4. Node.js (Latest LTS version)
# 5. Yarn (Package Manager alternative to npm)
# 6. Visual Studio Code (Standard React Editor)
# 7. Watchman (Facebook's file watching service, often needed for React Native/Jest)
# ------------------------------------------------------------------------------

# Define colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Starting MacOS Development Environment Setup...${NC}"

# 1. Check for Homebrew and install if missing
echo -e "${BLUE}Checking for Homebrew...${NC}"
if ! command -v brew &> /dev/null; then
    echo -e "${RED}Homebrew not found. Installing...${NC}"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    
    # Add Homebrew to path for Apple Silicon (M1/M2/M3) or Intel
    if [[ $(uname -m) == 'arm64' ]]; then
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
else
    echo -e "${GREEN}Homebrew is already installed.${NC}"
fi

# Update Homebrew recipes
echo -e "${BLUE}Updating Homebrew...${NC}"
brew update

# 2. Install Git
echo -e "${BLUE}Checking for Git...${NC}"
if ! command -v git &> /dev/null; then
    echo "Installing Git..."
    brew install git
else
    echo -e "${GREEN}Git is already installed.${NC}"
fi

# 3. Install VS Code (Cask)
echo -e "${BLUE}Checking for Visual Studio Code...${NC}"
if ! brew list --cask | grep -q "visual-studio-code"; then
    echo "Installing Visual Studio Code..."
    brew install --cask visual-studio-code
else
    echo -e "${GREEN}VS Code is already installed.${NC}"
fi

# 4. Install Watchman (Useful for React/React Native)
echo -e "${BLUE}Checking for Watchman...${NC}"
if ! command -v watchman &> /dev/null; then
    echo "Installing Watchman..."
    brew install watchman
else
    echo -e "${GREEN}Watchman is already installed.${NC}"
fi

# 5. Install NVM (Node Version Manager)
# We check if NVM directory exists to determine installation
export NVM_DIR="$HOME/.nvm"
if [ ! -d "$NVM_DIR" ]; then
    echo -e "${BLUE}Installing NVM (Node Version Manager)...${NC}"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

    # Immediately load NVM into this script session
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
else
    echo -e "${GREEN}NVM is already installed.${NC}"
    # Load NVM if it exists but isn't loaded
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi

# 6. Install Node.js (LTS) using NVM
echo -e "${BLUE}Installing Node.js (LTS)...${NC}"
nvm install --lts
nvm use --lts
nvm alias default 'lts/*'

# 7. Install Yarn (Global)
echo -e "${BLUE}Installing Yarn...${NC}"
npm install --global yarn

# 8. Cleanup
echo -e "${BLUE}Cleaning up Homebrew cache...${NC}"
brew cleanup

# ------------------------------------------------------------------------------
# Verification & Summary
# ------------------------------------------------------------------------------
echo -e "\n${GREEN}-----------------------------------------------------${NC}"
echo -e "${GREEN}Setup Complete!${NC}"
echo -e "${GREEN}-----------------------------------------------------${NC}"
echo -e "Versions installed:"
echo -e "Git:  $(git --version)"
echo -e "Node: $(node --version)"
echo -e "NPM:  $(npm --version)"
echo -e "Yarn: $(yarn --version)"
echo -e "VS Code installed"

echo -e "\n${RED}IMPORTANT NOTE:${NC}"
echo "Please restart your terminal or run 'source ~/.zshrc' (or ~/.bashrc) to ensure all paths are loaded correctly."
echo "You can now create a project using: npm create vite@latest my-app -- --template react"