package com.bislink360.tributary.spike.front;

import io.modelcontextprotocol.modern.McpException;
import io.modelcontextprotocol.modern.McpSchema.Tool;
import io.modelcontextprotocol.modern.server.McpRequestContext;
import io.modelcontextprotocol.modern.server.McpSyncResponse;
import io.modelcontextprotocol.modern.server.feature.McpSyncTool;
import io.modelcontextprotocol.modern.server.feature.McpSyncToolRepository;
import io.modelcontextprotocol.modern.server.feature.ToolsPage;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * The front's tools: the legacy backend's tools as they were when the front started, each call
 * passed to the backend. The list is read once because a 2026-07-28 tool list must not vary per
 * connection (MCP 2026-07-28, server/tools). Immutable, so safe to use from several threads.
 */
final class BackendTools implements McpSyncToolRepository {

  private final List<Tool> definitions;
  private final Map<String, McpSyncTool> toolsByName;

  private BackendTools(List<Tool> definitions, Map<String, McpSyncTool> toolsByName) {
    this.definitions = definitions;
    this.toolsByName = toolsByName;
  }

  static BackendTools readFrom(LegacyBackend backend) {
    List<Tool> definitions = backend.tools();
    Map<String, McpSyncTool> toolsByName =
        definitions.stream()
            .collect(Collectors.toUnmodifiableMap(Tool::name, tool -> relayTo(backend, tool)));
    return new BackendTools(definitions, toolsByName);
  }

  private static McpSyncTool relayTo(LegacyBackend backend, Tool definition) {
    return McpSyncTool.of(
        definition,
        (context, request) ->
            McpSyncResponse.result(backend.callTool(request.name(), request.arguments())));
  }

  @Override
  public ToolsPage list(McpRequestContext context, String cursor) {
    if (cursor != null) {
      // The list is a single page, so no cursor was ever issued; an invalid cursor is answered
      // with -32602 (MCP 2026-07-28, server/utilities/pagination, "Error Handling").
      throw McpException.invalidParams("Unknown cursor: " + cursor);
    }
    return ToolsPage.of(definitions);
  }

  /**
   * Returns the tool, or {@code null} if the backend has none of that name: the SDK's repository
   * contract, which it answers with "Unknown tool".
   */
  @Override
  public McpSyncTool find(McpRequestContext context, String name) {
    return toolsByName.get(name);
  }
}
