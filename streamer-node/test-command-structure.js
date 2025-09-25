const { NodeFFmpegService } = require('./dist/src/infrastructure/services/NodeFFmpegService');
const { ConsoleLogger } = require('./dist/src/infrastructure/logging/ConsoleLogger');
const { Config } = require('./dist/src/infrastructure/config/Config');
const { StreamUrl } = require('./dist/src/domain/value-objects/StreamUrl');

console.log('Testing FFmpeg command structure...');

const logger = new ConsoleLogger();
const config = Config.getInstance();
const ffmpegService = new NodeFFmpegService(logger, config);

try {
  // Test with audio (like your working command)
  const streamUrl = StreamUrl.create('rtsp://admin:ubnt%40966@192.168.10.111:554/cam/realmonitor?channel=1&subtype=1');
  const command = ffmpegService.buildStreamCommand(streamUrl, 'test-key', false); // false = no audio, like your working command
  
  console.log('\n=== Generated FFmpeg Command ===');
  console.log('Command:', command.command);
  console.log('Arguments:');
  command.args.forEach((arg, index) => {
    console.log(`  [${index}]: "${arg}"`);
  });
  
  // Check for the filter_complex argument specifically
  const filterComplexIndex = command.args.indexOf('-filter_complex');
  if (filterComplexIndex !== -1 && filterComplexIndex + 1 < command.args.length) {
    console.log('\n=== Filter Complex Content ===');
    console.log(command.args[filterComplexIndex + 1]);
  }
  
  console.log('\n✅ Command structure generated successfully');
} catch (error) {
  console.log('❌ Error generating command:', error.message);
}