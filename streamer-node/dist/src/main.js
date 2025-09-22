"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Config_1 = require("./infrastructure/config/Config");
const ConsoleLogger_1 = require("./infrastructure/logging/ConsoleLogger");
const FileSystemStreamRepository_1 = require("./infrastructure/repositories/FileSystemStreamRepository");
const NodeFFmpegService_1 = require("./infrastructure/services/NodeFFmpegService");
const NodeSSEService_1 = require("./infrastructure/services/NodeSSEService");
const StartStreamUseCase_1 = require("./application/use-cases/StartStreamUseCase");
const StopStreamUseCase_1 = require("./application/use-cases/StopStreamUseCase");
const StreamManagerService_1 = require("./application/services/StreamManagerService");
class Application {
    constructor() {
        this.logger = new ConsoleLogger_1.ConsoleLogger('INFO');
    }
    async start() {
        try {
            this.logger.info('Starting Streamer Node Application');
            // Initialize configuration
            const config = Config_1.Config.getInstance();
            this.logger.info('Configuration loaded', { config: config.get() });
            // Initialize dependencies
            const streamRepository = new FileSystemStreamRepository_1.FileSystemStreamRepository(config.get().stream.persistentStateDir, this.logger);
            const ffmpegService = new NodeFFmpegService_1.NodeFFmpegService(this.logger, config);
            const sseService = new NodeSSEService_1.NodeSSEService(this.logger);
            // Initialize use cases
            const startStreamUseCase = new StartStreamUseCase_1.StartStreamUseCase(streamRepository, ffmpegService, this.logger);
            const stopStreamUseCase = new StopStreamUseCase_1.StopStreamUseCase(streamRepository, ffmpegService, this.logger);
            // Initialize stream manager
            this.streamManager = new StreamManagerService_1.StreamManagerService(streamRepository, ffmpegService, sseService, startStreamUseCase, stopStreamUseCase, this.logger, config);
            // Start the stream manager
            await this.streamManager.start();
            this.logger.info('Streamer Node Application started successfully');
            // Setup graceful shutdown
            this.setupGracefulShutdown();
        }
        catch (error) {
            this.logger.error('Failed to start application', {
                error: error instanceof Error ? error.message : String(error)
            });
            process.exit(1);
        }
    }
    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            this.logger.info(`Received ${signal}, shutting down gracefully`);
            try {
                if (this.streamManager) {
                    await this.streamManager.stop();
                }
                this.logger.info('Application shutdown completed');
                process.exit(0);
            }
            catch (error) {
                this.logger.error('Error during shutdown', {
                    error: error instanceof Error ? error.message : String(error)
                });
                process.exit(1);
            }
        };
        // Handle different shutdown signals
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGUSR2', () => shutdown('SIGUSR2')); // nodemon restart
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            this.logger.error('Uncaught exception', { error: error.message });
            process.exit(1);
        });
        process.on('unhandledRejection', (reason) => {
            this.logger.error('Unhandled rejection', { reason });
            process.exit(1);
        });
    }
}
// Start the application
const app = new Application();
app.start().catch((error) => {
    console.error('Failed to start application:', error);
    process.exit(1);
});
//# sourceMappingURL=main.js.map