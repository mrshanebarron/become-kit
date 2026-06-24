import { startServer, registerTools } from './server.js';
import relayTools from './tools/relay.js';
import statusTools from './tools/status.js';
import threadTools from './tools/thread.js';
import waitTools from './tools/wait.js';
import sharedDocTools from './tools/shared_doc.js';
import peersTools from './tools/peers.js';
import taskTools from './tools/tasks.js';
import { SESSION_ID, AGENT_NAME, INSTANCE_ID } from './identity.js';

async function main(): Promise<void> {
  try {
    registerTools(relayTools);
    registerTools(statusTools);
    registerTools(threadTools);
    registerTools(waitTools);
    registerTools(sharedDocTools);
    registerTools(peersTools);
    registerTools(taskTools);
    const totalTools =
      relayTools.length +
      statusTools.length +
      threadTools.length +
      waitTools.length +
      sharedDocTools.length +
      peersTools.length +
      taskTools.length;
    console.error(
      `Relay MCP v2.0.0 — ${totalTools} tools | agent=${AGENT_NAME} instance=${INSTANCE_ID} session=${SESSION_ID}`,
    );
    await startServer();
  } catch (error) {
    console.error('Relay MCP failed to start:', error);
    process.exit(1);
  }
}

main();
