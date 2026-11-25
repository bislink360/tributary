package com.bislink360.tributary.spike.front;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.TypeRef;
import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Checks the front's HTTP exchange itself, with hand-written requests, against MCP 2026-07-28
 * (basic/transports/streamable-http, basic/versioning, server/discover).
 */
class ModernFrontWireTest {

  private static final String DISCOVER =
      """
      {"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}}}}
      """;

  private static final String CALL_GREET =
      """
      {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"greet","arguments":{"name":"Ada"},"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}}}}
      """;

  private static final String CALL_UNKNOWN_TOOL =
      """
      {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"place_order","arguments":{},"_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}}}}
      """;

  private static final String LEGACY_INITIALIZE =
      """
      {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},
        "clientInfo":{"name":"legacy-client","version":"1.0"}}}
      """;

  private static final HttpClient HTTP = HttpClient.newHttpClient();

  private static GreetingLegacyServer backend;
  private static ModernFront front;

  @BeforeAll
  static void startBackendAndFront() {
    backend = GreetingLegacyServer.start();
    front = ModernFront.start(0, backend.endpoint(), Duration.ofSeconds(30));
  }

  @AfterAll
  static void stopFrontAndBackend() {
    front.close();
    backend.close();
  }

  @Test
  void answersDiscoverOnTheFirstRequestWithoutCreatingASession() throws Exception {
    HttpResponse<String> response = post(modernRequest("server/discover", DISCOVER));

    assertEquals(200, response.statusCode());
    assertFalse(response.headers().firstValue("Mcp-Session-Id").isPresent());
    Map<String, Object> result = member(json(response), "result");
    assertEquals("complete", result.get("resultType"));
    assertEquals(List.of("2026-07-28"), result.get("supportedVersions"));
    assertTrue(member(result, "capabilities").containsKey("tools"));
    Map<String, Object> serverInfo =
        member(member(result, "_meta"), "io.modelcontextprotocol/serverInfo");
    assertEquals("tributary-spike-front", serverInfo.get("name"));
  }

  @Test
  void answersAToolCallWithTheBackendsResult() throws Exception {
    HttpRequest.Builder request =
        modernRequest("tools/call", CALL_GREET).header("Mcp-Name", "greet");

    HttpResponse<String> response = post(request);

    assertEquals(200, response.statusCode());
    Map<String, Object> result = member(json(response), "result");
    assertEquals("complete", result.get("resultType"));
    assertEquals(List.of(Map.of("type", "text", "text", "Hello, Ada!")), result.get("content"));
  }

  @Test
  void rejectsACallToAToolTheBackendDoesNotHave() throws Exception {
    HttpRequest.Builder request =
        modernRequest("tools/call", CALL_UNKNOWN_TOOL).header("Mcp-Name", "place_order");

    HttpResponse<String> response = post(request);

    Map<String, Object> error = member(json(response), "error");
    assertEquals(-32602, error.get("code"));
    assertEquals("Unknown tool: place_order", error.get("message"));
  }

  @Test
  void tellsAClientThatSendsTheLegacyHandshakeWhichVersionItSpeaks() throws Exception {
    HttpRequest.Builder request =
        HttpRequest.newBuilder(front.endpoint())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .POST(BodyPublishers.ofString(LEGACY_INITIALIZE));

    HttpResponse<String> response = post(request);

    assertEquals(400, response.statusCode());
    Map<String, Object> error = member(json(response), "error");
    assertEquals(List.of("2026-07-28"), member(error, "data").get("supported"));
    assertTrue(error.get("message").toString().contains("2026-07-28"), error.toString());
  }

  @Test
  void rejectsARequestWhoseMethodHeaderDisagreesWithItsBody() throws Exception {
    HttpResponse<String> response = post(modernRequest("tools/list", DISCOVER));

    assertEquals(400, response.statusCode());
    assertEquals(-32020, member(json(response), "error").get("code"));
  }

  @Test
  void rejectsARequestThatCarriesABrowserOrigin() throws Exception {
    HttpRequest.Builder request =
        modernRequest("server/discover", DISCOVER).header("Origin", "https://example.com");

    HttpResponse<String> response = post(request);

    assertEquals(403, response.statusCode());
  }

  private static HttpRequest.Builder modernRequest(String method, String body) {
    return HttpRequest.newBuilder(front.endpoint())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", method)
        .POST(BodyPublishers.ofString(body));
  }

  private static HttpResponse<String> post(HttpRequest.Builder request)
      throws IOException, InterruptedException {
    return HTTP.send(request.build(), BodyHandlers.ofString());
  }

  private static Map<String, Object> json(HttpResponse<String> response) throws IOException {
    return McpJsonDefaults.getMapper().readValue(response.body(), new TypeRef<>() {});
  }

  private static Map<String, Object> member(Map<String, Object> object, String name) {
    return McpJsonDefaults.getMapper().convertValue(object.get(name), new TypeRef<>() {});
  }
}
