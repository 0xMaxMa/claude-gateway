-include .env
export

.DEFAULT_GOAL := help

.PHONY: help start create-agent update-agent pair plugin-install

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

pair: ## Approve a Telegram pairing (e.g. make pair agent=alfred code=abc123)
	./node_modules/.bin/ts-node scripts/pair.ts --agent=$(agent) --code=$(code)

plugin-install: ## Install the Telegram plugin and enable channels mode
	cd plugins/telegram && bun install
	node scripts/setup-claude-settings.js
	claude plugin marketplace add ./plugins/marketplace.json
	claude plugin install telegram@claude-gateway
