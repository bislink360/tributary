package com.bislink360.tributary.spike.legacy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.HttpClientStreamableHttpTransport;
import io.modelcontextprotocol.spec.McpSchema.CallToolRequest;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.ClientCapabilities;
import io.modelcontextprotocol.spec.McpSchema.ElicitFormRequest;
import io.modelcontextprotocol.spec.McpSchema.ElicitResult;
import io.modelcontextprotocol.spec.McpSchema.ElicitResult.Action;
import io.modelcontextprotocol.spec.McpSchema.InitializeResult;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.net.URI;
import java.time.Duration;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class OrdersLegacyServerTest {

  private static final Duration CLIENT_TIMEOUT = Duration.ofSeconds(30);

  private static OrdersLegacyServer server;

  @BeforeAll
  static void startServer() {
    server = OrdersLegacyServer.start(0, Duration.ofSeconds(30));
  }

  @AfterAll
  static void stopServer() {
    server.close();
  }

  @Test
  void negotiatesProtocolVersion20251125() {
    try (McpSyncClient client = elicitingClient(server.endpoint(), new ScriptedUser())) {
      InitializeResult initialized = client.initialize();

      assertEquals("2025-11-25", initialized.protocolVersion());
    }
  }

  @Test
  void listsOnlyThePlaceOrderTool() {
    try (McpSyncClient client = elicitingClient(server.endpoint(), new ScriptedUser())) {
      client.initialize();

      List<Tool> tools = client.listTools().tools();

      assertEquals(List.of(PlaceOrderTool.NAME), tools.stream().map(Tool::name).toList());
    }
  }

  @Test
  void placesOrderAfterTheUserAnswersTwoQuestionsInTurn() {
    var user =
        new ScriptedUser(accept(Map.of("quantity", 3)), accept(Map.of("shipping", "express")));

    CallToolResult result = placeOrder(user, "widgets");

    assertFalse(result.isError());
    assertEquals("Order placed: 3 x widgets, express shipping.", text(result));
    assertEquals(
        List.of("How many widgets should be ordered?", "Which shipping option for 3 x widgets?"),
        user.questionsAsked());
  }

  @Test
  void asksForAWholeQuantityThenAShippingOption() {
    var user =
        new ScriptedUser(accept(Map.of("quantity", 1)), accept(Map.of("shipping", "standard")));

    placeOrder(user, "widgets");

    assertEquals(
        List.of(
            Map.of(
                "type",
                "object",
                "properties",
                Map.of("quantity", Map.of("type", "integer", "minimum", 1, "maximum", 100)),
                "required",
                List.of("quantity")),
            Map.of(
                "type",
                "object",
                "properties",
                Map.of(
                    "shipping", Map.of("type", "string", "enum", List.of("standard", "express"))),
                "required",
                List.of("shipping"))),
        user.schemasShown());
  }

  @Test
  void reportsDeclineOfTheFirstQuestionWithoutAskingTheSecond() {
    var user = new ScriptedUser(new ElicitResult(Action.DECLINE, null));

    CallToolResult result = placeOrder(user, "widgets");

    assertTrue(result.isError());
    assertEquals("The user declined the quantity question.", text(result));
    assertEquals(1, user.questionsAsked().size());
  }

  @Test
  void reportsDismissalOfTheSecondQuestion() {
    var user =
        new ScriptedUser(accept(Map.of("quantity", 2)), new ElicitResult(Action.CANCEL, null));

    CallToolResult result = placeOrder(user, "widgets");

    assertTrue(result.isError());
    assertEquals("The user dismissed the shipping question.", text(result));
  }

  @Test
  void rejectsAQuantityOutsideTheAllowedRange() {
    var user = new ScriptedUser(accept(Map.of("quantity", 101)));

    CallToolResult result = placeOrder(user, "widgets");

    assertTrue(result.isError());
    assertEquals(
        "The answer to the quantity question must be a whole number from 1 to 100.", text(result));
  }

  @Test
  void rejectsAnAcceptedAnswerWithoutContent() {
    var user = new ScriptedUser(new ElicitResult(Action.ACCEPT, null));

    CallToolResult result = placeOrder(user, "widgets");

    assertTrue(result.isError());
    assertEquals(
        "The answer to the quantity question must be a whole number from 1 to 100.", text(result));
  }

  @Test
  void rejectsAnUnknownShippingOption() {
    var user =
        new ScriptedUser(accept(Map.of("quantity", 2)), accept(Map.of("shipping", "overnight")));

    CallToolResult result = placeOrder(user, "widgets");

    assertTrue(result.isError());
    assertEquals(
        "The answer to the shipping question must be one of [standard, express].", text(result));
  }

  @Test
  void reportsAnErrorReturnedInPlaceOfAnAnswer() {
    Function<ElicitFormRequest, ElicitResult> failingUser =
        request -> {
          throw new IllegalStateException("no user interface available");
        };

    CallToolResult result;
    try (McpSyncClient client = elicitingClient(server.endpoint(), failingUser)) {
      client.initialize();
      result = client.callTool(placeOrderRequest("widgets"));
    }

    assertTrue(result.isError());
    assertTrue(
        text(result).startsWith("The quantity question got an error instead of an answer: "),
        text(result));
  }

  @Test
  void refusesAClientThatCannotAskTheUserQuestions() {
    CallToolResult result;
    try (McpSyncClient client = clientWithoutElicitation(server.endpoint())) {
      client.initialize();
      result = client.callTool(placeOrderRequest("widgets"));
    }

    assertTrue(result.isError());
    assertEquals(
        "place_order asks the user two questions, but this client does not support form"
            + " elicitation.",
        text(result));
  }

  @Test
  void rejectsACallWithABlankItemBeforeAskingAnything() {
    var user = new ScriptedUser();

    CallToolResult result = placeOrder(user, "   ");

    assertTrue(result.isError());
    assertEquals("place_order needs a non-empty \"item\" argument.", text(result));
    assertEquals(List.of(), user.questionsAsked());
  }

  private static CallToolResult placeOrder(ScriptedUser user, String item) {
    try (McpSyncClient client = elicitingClient(server.endpoint(), user)) {
      client.initialize();
      return client.callTool(placeOrderRequest(item));
    }
  }

  static CallToolRequest placeOrderRequest(String item) {
    return new CallToolRequest(PlaceOrderTool.NAME, Map.of("item", item));
  }

  static McpSyncClient elicitingClient(
      URI endpoint, Function<ElicitFormRequest, ElicitResult> user) {
    return McpClient.sync(transport(endpoint))
        .requestTimeout(CLIENT_TIMEOUT)
        .capabilities(ClientCapabilities.builder().elicitation().build())
        .elicitation(user)
        .build();
  }

  private static McpSyncClient clientWithoutElicitation(URI endpoint) {
    return McpClient.sync(transport(endpoint)).requestTimeout(CLIENT_TIMEOUT).build();
  }

  private static HttpClientStreamableHttpTransport transport(URI endpoint) {
    String base = endpoint.getScheme() + "://" + endpoint.getAuthority();
    return HttpClientStreamableHttpTransport.builder(base).endpoint(endpoint.getPath()).build();
  }

  static String text(CallToolResult result) {
    return ((TextContent) result.content().get(0)).text();
  }

  private static ElicitResult accept(Map<String, Object> content) {
    return new ElicitResult(Action.ACCEPT, content);
  }

  /** Answers each question with the next scripted response and records what it was asked. */
  private static final class ScriptedUser implements Function<ElicitFormRequest, ElicitResult> {
    private final Deque<ElicitResult> answers;
    private final List<ElicitFormRequest> requests = new CopyOnWriteArrayList<>();

    ScriptedUser(ElicitResult... answers) {
      this.answers = new ConcurrentLinkedDeque<>(List.of(answers));
    }

    @Override
    public ElicitResult apply(ElicitFormRequest request) {
      requests.add(request);
      ElicitResult answer = answers.poll();
      if (answer == null) {
        throw new IllegalStateException("Unexpected question: " + request.message());
      }
      return answer;
    }

    List<String> questionsAsked() {
      return requests.stream().map(ElicitFormRequest::message).toList();
    }

    List<Map<String, Object>> schemasShown() {
      return requests.stream().map(ElicitFormRequest::requestedSchema).toList();
    }
  }
}
