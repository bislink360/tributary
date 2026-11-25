package com.bislink360.tributary.spike.front;

import com.bislink360.tributary.spike.http.LoopbackHttpListener;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.HttpServletStreamableServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.ServerCapabilities;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.net.URI;
import java.util.List;
import java.util.Map;

/**
 * A legacy MCP server whose {@code greet} tool answers without asking the user anything, so a test
 * can follow one call's arguments to the backend and its result back.
 */
final class GreetingLegacyServer implements AutoCloseable {

  static final String TOOL_NAME = "greet";

  private static final String MCP_PATH = "/mcp";

  private static final Map<String, Object> INPUT_SCHEMA =
      Map.of(
          "type",
          "object",
          "properties",
          Map.of("name", Map.of("type", "string")),
          "required",
          List.of("name"));

  private final LoopbackHttpListener listener;
  private final McpSyncServer mcp;

  private GreetingLegacyServer(LoopbackHttpListener listener, McpSyncServer mcp) {
    this.listener = listener;
    this.mcp = mcp;
  }

  static GreetingLegacyServer start() {
    var transport =
        HttpServletStreamableServerTransportProvider.builder()
            .jsonMapper(McpJsonDefaults.getMapper())
            .mcpEndpoint(MCP_PATH)
            .build();
    McpSyncServer mcp =
        McpServer.sync(transport)
            .serverInfo("greeting-legacy", "0.1.0")
            .capabilities(ServerCapabilities.builder().tools(false).build())
            .tools(greetTool())
            .build();
    return new GreetingLegacyServer(LoopbackHttpListener.start(0, transport, MCP_PATH), mcp);
  }

  private static SyncToolSpecification greetTool() {
    Tool tool = Tool.builder(TOOL_NAME, INPUT_SCHEMA).description("Greets a person.").build();
    return SyncToolSpecification.builder()
        .tool(tool)
        .callHandler((exchange, request) ->
            CallToolResult.builder()
                .addTextContent("Hello, " + request.arguments().get("name") + "!")
                .isError(false)
                .build())
        .build();
  }

  URI endpoint() {
    return listener.endpoint();
  }

  @Override
  public void close() {
    mcp.closeGracefully();
    listener.stop();
  }
}
