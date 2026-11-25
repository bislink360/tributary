package com.bislink360.tributary.spike.front;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.bislink360.tributary.spike.legacy.OrdersLegacyServer;
import io.modelcontextprotocol.modern.McpException;
import io.modelcontextprotocol.modern.McpSchema.CallToolResult;
import io.modelcontextprotocol.modern.McpSchema.DiscoverResult;
import io.modelcontextprotocol.modern.McpSchema.TextContent;
import io.modelcontextprotocol.modern.McpSchema.Tool;
import io.modelcontextprotocol.modern.client.McpClient;
import io.modelcontextprotocol.modern.client.McpSyncClient;
import io.modelcontextprotocol.modern.client.transport.HttpClientMcpTransport;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** Drives the front with the SDK's 2026-07-28 client, with a real legacy server behind it. */
class ModernFrontTest {

  private static final Duration BACKEND_TIMEOUT = Duration.ofSeconds(30);

  private static OrdersLegacyServer orders;
  private static GreetingLegacyServer greeting;
  private static ModernFront ordersFront;
  private static ModernFront greetingFront;

  @BeforeAll
  static void startBackendsAndFronts() {
    orders = OrdersLegacyServer.start(0, BACKEND_TIMEOUT);
    greeting = GreetingLegacyServer.start();
    ordersFront = ModernFront.start(0, orders.endpoint(), BACKEND_TIMEOUT);
    greetingFront = ModernFront.start(0, greeting.endpoint(), BACKEND_TIMEOUT);
  }

  @AfterAll
  static void stopFrontsAndBackends() {
    greetingFront.close();
    ordersFront.close();
    greeting.close();
    orders.close();
  }

  @Test
  void tellsAModernClientWhatItSupports() {
    DiscoverResult discovered = client(ordersFront).discover();

    assertEquals(List.of("2026-07-28"), discovered.supportedVersions());
    assertNotNull(discovered.capabilities().tools());
  }

  @Test
  void listsTheBackendToolWithItsDescriptionAndInputSchema() {
    List<Tool> tools = client(ordersFront).listTools().list().tools();

    assertEquals(1, tools.size());
    Tool tool = tools.get(0);
    assertEquals("place_order", tool.name());
    assertEquals(
        "Places an order after asking the user for the quantity and shipping.", tool.description());
    assertEquals(
        Map.of(
            "type",
            "object",
            "properties",
            Map.of("item", Map.of("type", "string", "minLength", 1)),
            "required",
            List.of("item")),
        tool.inputSchema());
  }

  @Test
  void passesACallToTheBackendAndItsResultBack() {
    CallToolResult result =
        client(greetingFront)
            .tool(GreetingLegacyServer.TOOL_NAME)
            .arguments(Map.of("name", "Ada"))
            .call();

    assertNotEquals(Boolean.TRUE, result.isError());
    assertEquals("Hello, Ada!", text(result));
  }

  @Test
  void passesBackTheBackendsRefusalWhenItsToolNeedsToAskTheUser() {
    CallToolResult result =
        client(ordersFront).tool("place_order").arguments(Map.of("item", "widgets")).call();

    assertEquals(Boolean.TRUE, result.isError());
    assertEquals(
        "place_order asks the user two questions, but this client does not support form"
            + " elicitation.",
        text(result));
  }

  @Test
  void rejectsArgumentsThatBreakTheToolsInputSchemaWithAToolError() {
    CallToolResult result =
        client(greetingFront)
            .tool(GreetingLegacyServer.TOOL_NAME)
            .arguments(Map.of("name", 42))
            .call();

    assertEquals(Boolean.TRUE, result.isError());
    assertTrue(text(result).startsWith("Invalid arguments: "), text(result));
  }

  @Test
  void rejectsAToolListCursorItNeverIssued() {
    var listing = client(greetingFront).tools().cursor("page-2");

    McpException rejection = assertThrows(McpException.class, listing::list);

    assertEquals(-32602, rejection.error().code());
    assertEquals("Unknown cursor: page-2", rejection.error().message());
  }

  @Test
  void answersAnInternalErrorWhenTheBackendIsGoneDuringACall() {
    McpException answer;
    try (GreetingLegacyServer backend = GreetingLegacyServer.start();
        ModernFront front = ModernFront.start(0, backend.endpoint(), BACKEND_TIMEOUT)) {
      var call =
          client(front).tool(GreetingLegacyServer.TOOL_NAME).arguments(Map.of("name", "Ada"));
      client(front).listTools().list();
      backend.close();

      answer = assertThrows(McpException.class, call::call);
    }

    assertEquals(-32603, answer.error().code());
    assertEquals("Internal error", answer.error().message());
  }

  @Test
  void refusesToStartWhenTheBackendCannotBeReached() {
    URI nobodyListening;
    try (GreetingLegacyServer stopped = GreetingLegacyServer.start()) {
      nobodyListening = stopped.endpoint();
    }

    IllegalStateException refusal =
        assertThrows(
            IllegalStateException.class,
            () -> ModernFront.start(0, nobodyListening, BACKEND_TIMEOUT));

    assertEquals("Could not reach the legacy backend at " + nobodyListening, refusal.getMessage());
  }

  @Test
  void rejectsAPortOutsideTheValidRange() {
    URI backend = greeting.endpoint();

    IllegalArgumentException rejection =
        assertThrows(
            IllegalArgumentException.class,
            () -> ModernFront.start(65_536, backend, BACKEND_TIMEOUT));

    assertEquals("port must be between 0 and 65535, got 65536", rejection.getMessage());
  }

  @Test
  void rejectsABackendTimeoutThatIsNotPositive() {
    URI backend = greeting.endpoint();

    IllegalArgumentException rejection =
        assertThrows(
            IllegalArgumentException.class, () -> ModernFront.start(0, backend, Duration.ZERO));

    assertEquals("backendTimeout must be positive, got PT0S", rejection.getMessage());
  }

  @Test
  void reportsThatItsPortIsTaken() {
    URI backend = greeting.endpoint();
    int takenPort = greetingFront.endpoint().getPort();

    IllegalStateException refusal =
        assertThrows(
            IllegalStateException.class,
            () -> ModernFront.start(takenPort, backend, BACKEND_TIMEOUT));

    assertEquals("Could not start the HTTP listener on port " + takenPort, refusal.getMessage());
  }

  private static McpSyncClient client(ModernFront front) {
    return McpClient.sync(HttpClientMcpTransport.builder(front.endpoint()).build()).build();
  }

  private static String text(CallToolResult result) {
    return ((TextContent) result.content().get(0)).text();
  }
}
