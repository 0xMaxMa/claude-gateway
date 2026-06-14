-include .env
export

.DEFAULT_GOAL := help

.PHONY: help start stop create-agent update-agent pair mcp-install release pm2-start pm2-stop pm2-restart pm2-startup pm2-remove pm2-logs system-start system-stop system-restart system-logs

help: ## Show this help message
	@echo "----------------------------------------"
	@echo "\033[0;34mClaude Gateway - Available Commands:\033[0m"
	@echo "----------------------------------------"
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""

start: ## Build and start the gateway
	npm run build && npm start

start-dev: ## Dev mode — tsc --watch + hot-reload /dashboard on save (no gateway restart needed)
	npm run build
	@trap 'kill 0' EXIT; ./node_modules/.bin/tsc --watch & DEV_MODE=1 node --no-warnings=ExperimentalWarning --env-file-if-exists=.env dist/index.js

stop: ## Stop claude-gateway (node dist/index.js) and all spawned children
	@echo "Stopping claude-gateway..."
	-@pkill -f "[n]ode dist/index\.js" 2>/dev/null || true
	@sleep 2
	-@pkill -9 -f "[n]ode dist/index\.js" 2>/dev/null || true
	-@pkill -9 -f "[b]un .*/claude-gateway/mcp/" 2>/dev/null || true
	-@pkill -9 -f "[c]laude .*--mcp-config .*/claude-gateway/" 2>/dev/null || true
	@pgrep -af "[n]ode dist/index\.js|[b]un .*/claude-gateway/mcp/|[c]laude .*--mcp-config .*/claude-gateway/" >/dev/null \
		&& { echo "WARNING: some processes still alive:"; pgrep -af "[n]ode dist/index\.js|[b]un .*/claude-gateway/mcp/|[c]laude .*--mcp-config .*/claude-gateway/"; exit 1; } \
		|| echo "Stopped"

create-agent: ## Run the interactive wizard to create a new agent
	./node_modules/.bin/ts-node scripts/create-agent.ts

update-agent: ## Update agent.md or manage channels for an existing agent
	./node_modules/.bin/ts-node scripts/update-agent.ts

pair: ## Approve a channel pairing (e.g. make pair agent=alfred code=abc123 channel=telegram)
	./node_modules/.bin/ts-node scripts/pair.ts --agent=$(agent) --code=$(code) --channel=$(or $(channel),telegram)

mcp-install: ## Install MCP gateway dependencies
	cd mcp && bun install
	node scripts/setup-claude-settings.js

release: ## Interactive release — choose patch/minor/major with version preview and confirm
	@bash scripts/release.sh

pm2-start: ## Build and start gateway via pm2 (auto-restart on crash, saves process list)
	npm run build
	-pm2 delete gateway
	pm2 start node --name gateway -- --no-warnings=ExperimentalWarning --env-file-if-exists=.env dist/index.js
	pm2 save

pm2-stop: ## Stop gateway via pm2
	pm2 stop gateway

pm2-restart: ## Build and restart gateway via pm2
	npm run build
	pm2 restart gateway

pm2-remove: ## Delete gateway from pm2 process list
	pm2 delete gateway
	pm2 save

pm2-logs: ## Tail gateway logs via pm2
	pm2 logs gateway

pm2-startup: ## Register pm2 to start on boot (run once — requires sudo)
	@echo "Run the following command to enable pm2 on system boot:"
	@pm2 startup | grep "sudo env" || true

system-start: ## Start gateway via systemd (sudo systemctl start claude-gateway)
	sudo systemctl start claude-gateway

system-stop: ## Stop gateway via systemd (sudo systemctl stop claude-gateway)
	sudo systemctl stop claude-gateway

system-restart: ## Build and restart gateway via systemd
	npm run build && sudo systemctl restart claude-gateway

system-logs: ## Tail gateway logs via journalctl
	journalctl -f -u claude-gateway
