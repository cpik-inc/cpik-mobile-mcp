#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { program } from "commander";
import express from "express";
import { error } from "./logger";
import { createMcpServer, getAgentVersion } from "./server";

// Verbose logging utilities
const log = {
	info: (message: string, data?: any) => {
		const timestamp = new Date().toISOString();
		console.log(`[${timestamp}] [INFO] ${message}`, data ? JSON.stringify(data, null, 2) : "");
	},
	error: (message: string, error?: any) => {
		const timestamp = new Date().toISOString();
		console.error(`[${timestamp}] [ERROR] ${message}`, error ? (error.stack || JSON.stringify(error, null, 2)) : "");
	},
	debug: (message: string, data?: any) => {
		const timestamp = new Date().toISOString();
		console.log(`[${timestamp}] [DEBUG] ${message}`, data ? JSON.stringify(data, null, 2) : "");
	},
	warn: (message: string, data?: any) => {
		const timestamp = new Date().toISOString();
		console.warn(`[${timestamp}] [WARN] ${message}`, data ? JSON.stringify(data, null, 2) : "");
	},
};

const startHttpServer = async (port: number) => {
	log.info("Initializing HTTP server", { port, version: getAgentVersion() });

	const app = express();
	app.use(express.json());

	const server = createMcpServer();
	log.info("MCP server created successfully");

	// Request logging middleware
	app.use((req, res, next) => {
		const startTime = Date.now();
		const requestId = Math.random().toString(36).substring(7);

		log.info("Incoming HTTP request", {
			requestId,
			method: req.method,
			url: req.url,
			headers: req.headers,
		});

		// Log response when finished
		const originalSend = res.send;
		res.send = function(body) {
			const duration = Date.now() - startTime;
			log.info("HTTP response sent", {
				requestId,
				statusCode: res.statusCode,
				duration: `${duration}ms`,
				bodySize: body ? JSON.stringify(body).length : 0,
			});
			return originalSend.call(this, body);
		};

		next();
	});

	app.post("/mcp", async (req, res) => {
		const requestId = Math.random().toString(36).substring(7);
		const startTime = Date.now();

		log.debug("Processing MCP request", {
			requestId,
			body: req.body,
		});

		try {
			// Create a new transport for each request to prevent request ID collisions
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});

			log.debug("Transport created", { requestId });

			res.on("close", () => {
				const duration = Date.now() - startTime;
				log.info("Transport closed", {
					requestId,
					duration: `${duration}ms`,
				});
				transport.close();
			});

			log.debug("Connecting server to transport", { requestId });
			await server.connect(transport);

			log.debug("Handling transport request", { requestId });
			await transport.handleRequest(req, res, req.body);

			const duration = Date.now() - startTime;
			log.info("MCP request processed successfully", {
				requestId,
				duration: `${duration}ms`,
			});
		} catch (err) {
			const duration = Date.now() - startTime;
			log.error("MCP request processing failed", {
				requestId,
				error: err,
				duration: `${duration}ms`,
			});

			if (!res.headersSent) {
				res.status(500).json({ error: "Internal server error" });
			}
		}
	});

	app.listen(port, () => {
		log.info("Server started successfully", {
			url: `http://localhost:${port}/mcp`,
			port,
			version: getAgentVersion(),
			pid: process.pid,
		});
		error(`mobile-mcp ${getAgentVersion()} server listening on http://localhost:${port}/mcp`);
	}).on("error", err => {
		log.error("Server startup error", {
			error: err,
			port,
		});
		console.error("Server error:", err);
		process.exit(1);
	});
};

const startStdioServer = async () => {
	try {
		log.info("Initializing stdio server", { version: getAgentVersion() });

		const transport = new StdioServerTransport();
		const server = createMcpServer();

		await server.connect(transport);

		log.info("Stdio server started successfully");
		error("mobile-mcp server running on stdio");
	} catch (err: any) {
		log.error("Fatal error in stdio server", { error: err });
		console.error("Fatal error in main():", err);
		error("Fatal error in main(): " + JSON.stringify(err.stack));
		process.exit(1);
	}
};

const main = async () => {
	program
		.version(getAgentVersion())
		.option("--port <port>", "Start HTTP server on this port")
		.option("--stdio", "Start stdio server (default)")
		.parse(process.argv);

	const options = program.opts();

	if (options.port) {
		await startHttpServer(+options.port);
	} else {
		await startStdioServer();
	}
};

// Graceful shutdown logging
process.on("SIGTERM", () => {
	log.info("SIGTERM received, shutting down gracefully");
	process.exit(0);
});

process.on("SIGINT", () => {
	log.info("SIGINT received, shutting down gracefully");
	process.exit(0);
});

process.on("uncaughtException", err => {
	log.error("Uncaught exception", { error: err });
	process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
	log.error("Unhandled promise rejection", { reason, promise });
});

main().then();
