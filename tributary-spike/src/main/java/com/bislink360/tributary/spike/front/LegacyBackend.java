package com.bislink360.tributary.spike.front;

import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.HttpClientStreamableHttpTransport;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.modern.McpSchema.CallToolResult;
import io.modelcontextprotocol.modern.McpSchema.Tool;
import io.modelcontextprotocol.spec.McpSchema.CallToolRequest;
import io.modelcontextprotocol.spec.McpSchema.InitializeResult;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One session with a legacy MCP server, held through the official Java SDK's legacy client, with
 * its tools and tool results translated to the 2026-07-28 schema types. The two schema revisions
 * describe tools and tool results with the same JSON, so the translation is a JSON conversion.
 *
 * <p>The client declares no elicitation capability: a backend tool that needs to ask the user
 * learns from the handshake that it cannot. An instance is safe to use from several threads.
 */
final class LegacyBackend implements AutoCloseable {

  private static final Logger LOG = LoggerFactory.getLogger(LegacyBackend.class);

  private final McpSyncClient client;
  private final McpJsonMapper json = McpJsonDefaults.getMapper();

  private LegacyBackend(McpSyncClient client) {
    this.client = client;
  }

  /**
   * Opens the session with the {@code initialize} handshake.
   *
   * @param endpoint the backend's MCP endpoint, for example {@code http://127.0.0.1:9101/mcp}
   * @param requestTimeout how long each request to the backend waits for its response
   * @throws IllegalStateException if the handshake does not complete
   */
  static LegacyBackend connect(URI endpoint, Duration requestTimeout) {
    String base = endpoint.getScheme() + "://" + endpoint.getAuthority();
    var transport =
        HttpClientStreamableHttpTransport.builder(base).endpoint(endpoint.getPath()).build();
    McpSyncClient client = McpClient.sync(transport).requestTimeout(requestTimeout).build();
    try {
      InitializeResult initialized = client.initialize();
      LOG.info(
          "Connected to the legacy backend at {}, protocol version {}",
          endpoint,
          initialized.protocolVersion());
    } catch (RuntimeException e) {
      // The SDK reports every way a handshake can end without a session (refused connection,
      // timeout, an error response) as an unchecked exception of no common narrower type.
      client.close();
      throw new IllegalStateException("Could not reach the legacy backend at " + endpoint, e);
    }
    return new LegacyBackend(client);
  }

  List<Tool> tools() {
    return client.listTools().tools().stream()
        .map(tool -> json.convertValue(tool, Tool.class))
        .toList();
  }

  CallToolResult callTool(String name, Map<String, Object> arguments) {
    return json.convertValue(
        client.callTool(new CallToolRequest(name, arguments)), CallToolResult.class);
  }

  @Override
  public void close() {
    client.closeGracefully();
  }
}
