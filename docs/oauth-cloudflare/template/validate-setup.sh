#!/bin/bash
# MCP OAuth Server Setup Validation Script
# Run this after configuring .env to verify everything is ready

set -e

echo "=========================================="
echo "MCP OAuth Server Setup Validation"
echo "=========================================="
echo ""

# Check for required files
echo "1. Checking required files..."
REQUIRED_FILES=(
    "docker-compose.yml"
    "Dockerfile"
    "requirements.txt"
    ".env"
    "app/main.py"
    "app/auth.py"
    "app/config.py"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "   ✓ $file exists"
    else
        echo "   ✗ $file MISSING"
        exit 1
    fi
done
echo ""

# Check .env configuration
echo "2. Checking .env configuration..."
source .env 2>/dev/null || { echo "   ✗ Could not load .env"; exit 1; }

REQUIRED_VARS=(
    "AUTH0_DOMAIN"
    "AUTH0_CLIENT_ID"
    "AUTH0_CLIENT_SECRET"
    "AUTH0_AUDIENCE"
    "JWT_SECRET_KEY"
    "CW_COMPANY_ID"
    "CW_PUBLIC_KEY"
    "CW_PRIVATE_KEY"
    "CW_CLIENT_ID"
)

for var in "${REQUIRED_VARS[@]}"; do
    if [ -n "${!var}" ]; then
        # Mask sensitive values
        value="${!var}"
        if [[ "$var" == *"SECRET"* ]] || [[ "$var" == *"KEY"* ]] || [[ "$var" == *"PRIVATE"* ]]; then
            echo "   ✓ $var is set (${value:0:4}...)"
        else
            echo "   ✓ $var = $value"
        fi
    else
        echo "   ✗ $var is NOT SET"
        exit 1
    fi
done
echo ""

# Check Docker
echo "3. Checking Docker..."
if command -v docker &> /dev/null; then
    echo "   ✓ Docker is installed"
    docker --version
else
    echo "   ✗ Docker is NOT installed"
    exit 1
fi

if command -v docker compose &> /dev/null; then
    echo "   ✓ Docker Compose is available"
else
    echo "   ✗ Docker Compose is NOT available"
    exit 1
fi
echo ""

# Validate Auth0 configuration
echo "4. Testing Auth0 connectivity..."
AUTH0_TEST_URL="https://${AUTH0_DOMAIN}/.well-known/openid-configuration"
if curl -s --fail "$AUTH0_TEST_URL" > /dev/null 2>&1; then
    echo "   ✓ Auth0 domain is reachable"
else
    echo "   ✗ Cannot reach Auth0 at ${AUTH0_DOMAIN}"
    echo "     Check AUTH0_DOMAIN in .env (should NOT have https://)"
    exit 1
fi
echo ""

# Check Cloudflare tunnel token
echo "5. Checking Cloudflare configuration..."
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    echo "   ✓ CLOUDFLARE_TUNNEL_TOKEN is set"
else
    echo "   ⚠ CLOUDFLARE_TUNNEL_TOKEN is NOT set"
    echo "     The tunnel container will not start without this"
fi
echo ""

echo "=========================================="
echo "Validation Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Run: docker compose build"
echo "  2. Run: docker compose up -d"
echo "  3. Test: curl http://localhost:8000/health"
echo "  4. Open: http://localhost:8000/mcp_oauth_test.html"
echo ""
