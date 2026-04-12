# Codebase Inventory Snapshot

Created: 2026-04-12T13:56:41.082Z
Tags: inventory, codebase, dogfood

## Major Directories and Their Responsibilities

- **src/core**: Contains the core modules of the application such as agent-loop, llm-provider, types, and tool-registry.
- **src/tools**: Includes various tool modules like document-writer, markdown reader/writer, and kb-tools-registry.
- **src/cli**: Manages the command line interface components, handling the executable build pipeline and .env auto-loading.
- **tests**: Houses all testing scripts and frameworks, focusing on namespace isolation and policy adherence for CI/functional tests.
- **sessions**: Stores session data, managing session continuity and state across interactions.
- **business**: Holds business logic and application rules that govern the overall functionality.

## Key Runtime Scripts and Build Scripts

- **Build scripts**: Responsible for compiling the application, setting up the executable environment, and managing dependencies.
- **Runtime scripts**: Ensure the application runs smoothly, handling tasks such as session management, environment configuration, and error handling.
