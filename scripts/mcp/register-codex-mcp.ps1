#!/usr/bin/env pwsh
Set-StrictMode -Version Latest

$REPO = (Resolve-Path "$PSScriptRoot\..\..").Path

function Register-Server {
    param (
        [string]$Name,
        [string[]]$CommandLine
    )

    codex mcp remove $Name *> $null
    codex mcp add $Name --env WORKSPACE="$REPO" -- @CommandLine
}

Write-Host "Registering RouteKit MCP servers with Codex (repo: $REPO)"

Register-Server -Name "routekit-rag-routekit-shell" -CommandLine @("node", "$REPO/scripts/mcp/rag-server.mjs")
Register-Server -Name "routekit-dendron-routekit-shell" -CommandLine @("node", "$REPO/scripts/mcp/dendron-server.mjs")
Register-Server -Name "routekit-governance-routekit-shell" -CommandLine @("node", "$REPO/scripts/mcp/governance-server.mjs")

Write-Host "Done. Open the Codex MCP panel to confirm the servers are available."
