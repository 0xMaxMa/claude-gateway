-include .env
export

.DEFAULT_GOAL := help

.PHONY: help start create-agent update-agent update-agent-channel pair mcp-install

help: ## Show this help message
	@echo "----------------------------------------"
	@echo "\033[0;34mClaude Gateway - Available Commands:\033[0m"
	@echo "----------------------------------------"
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
	@echo ""

start: ## Build and start the gateway
	npm run build && npm start

create-agent: ## Run the interactive wizard to create a new agent
	./node_modules/.bin/ts-node scripts/create-agent.ts

update-agent: ## Update an existing agent's agent.md with Claude
	./node_modules/.bin/ts-node scripts/update-agent.ts

pair: ## Approve a channel pairing (e.g. make pair agent=alfred code=abc123 channel=telegram)
	./node_modules/.bin/ts-node scripts/pair.ts --agent=$(agent) --code=$(code) --channel=$(or $(channel),telegram)

update-agent-channel: ## Add, edit, or remove a channel on an existing agent (e.g. make update-agent-channel agent=alfred)
	./node_modules/.bin/ts-node scripts/update-agent-channel.ts --agent=$(agent)

mcp-install: ## Install MCP gateway dependencies
	cd mcp && bun install
	node scripts/setup-claude-settings.js
