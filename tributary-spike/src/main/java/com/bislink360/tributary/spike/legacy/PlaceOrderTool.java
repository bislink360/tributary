package com.bislink360.tributary.spike.legacy;

import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.McpSyncServerExchange;
import io.modelcontextprotocol.spec.McpError;
import io.modelcontextprotocol.spec.McpSchema.CallToolRequest;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.ClientCapabilities;
import io.modelcontextprotocol.spec.McpSchema.ElicitFormRequest;
import io.modelcontextprotocol.spec.McpSchema.ElicitResult;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeoutException;
import reactor.core.Exceptions;

/**
 * The {@code place_order} tool. During one call it asks the user how many items to order, then
 * which shipping option to use, each through a form-mode {@code elicitation/create} request (MCP
 * 2025-11-25, client/elicitation). Every way a call can end without an order is reported as a tool
 * error result whose text names the question concerned.
 */
final class PlaceOrderTool {

  static final String NAME = "place_order";
  static final int MAX_QUANTITY = 100;
  static final List<String> SHIPPING_OPTIONS = List.of("standard", "express");

  private static final String QUANTITY = "quantity";
  private static final String SHIPPING = "shipping";

  private static final Map<String, Object> INPUT_SCHEMA =
      objectSchema("item", Map.of("type", "string", "minLength", 1));

  private static final Map<String, Object> QUANTITY_SCHEMA =
      objectSchema(QUANTITY, Map.of("type", "integer", "minimum", 1, "maximum", MAX_QUANTITY));

  private static final Map<String, Object> SHIPPING_SCHEMA =
      objectSchema(SHIPPING, Map.of("type", "string", "enum", SHIPPING_OPTIONS));

  private PlaceOrderTool() {}

  static SyncToolSpecification specification() {
    Tool tool =
        Tool.builder(NAME, INPUT_SCHEMA)
            .description("Places an order after asking the user for the quantity and shipping.")
            .build();
    return SyncToolSpecification.builder().tool(tool).callHandler(PlaceOrderTool::call).build();
  }

  private static CallToolResult call(McpSyncServerExchange exchange, CallToolRequest request) {
    try {
      requireFormElicitation(exchange.getClientCapabilities());
      String item = itemArgument(request);
      int quantity = askQuantity(exchange, item);
      String shipping = askShipping(exchange, item, quantity);
      return result(
          false, "Order placed: %d x %s, %s shipping.".formatted(quantity, item, shipping));
    } catch (OrderNotPlacedException e) {
      return result(true, e.getMessage());
    }
  }

  private static void requireFormElicitation(ClientCapabilities capabilities)
      throws OrderNotPlacedException {
    // An empty elicitation capability means form support (MCP 2025-11-25, client/elicitation).
    boolean formSupported =
        capabilities != null
            && capabilities.elicitation() != null
            && (capabilities.elicitation().form() != null
                || capabilities.elicitation().url() == null);
    if (!formSupported) {
      throw new OrderNotPlacedException(
          NAME
              + " asks the user two questions, but this client does not support form elicitation.");
    }
  }

  private static String itemArgument(CallToolRequest request) throws OrderNotPlacedException {
    Map<String, Object> arguments = request.arguments();
    if (arguments != null && arguments.get("item") instanceof String item && !item.isBlank()) {
      return item;
    }
    throw new OrderNotPlacedException(NAME + " needs a non-empty \"item\" argument.");
  }

  private static int askQuantity(McpSyncServerExchange exchange, String item)
      throws OrderNotPlacedException {
    Map<String, Object> answer =
        ask(exchange, QUANTITY, "How many %s should be ordered?".formatted(item), QUANTITY_SCHEMA);
    if (answer.get(QUANTITY) instanceof Integer quantity
        && quantity >= 1
        && quantity <= MAX_QUANTITY) {
      return quantity;
    }
    throw new OrderNotPlacedException(
        "The answer to the quantity question must be a whole number from 1 to %d."
            .formatted(MAX_QUANTITY));
  }

  private static String askShipping(McpSyncServerExchange exchange, String item, int quantity)
      throws OrderNotPlacedException {
    String message = "Which shipping option for %d x %s?".formatted(quantity, item);
    Map<String, Object> answer = ask(exchange, SHIPPING, message, SHIPPING_SCHEMA);
    if (answer.get(SHIPPING) instanceof String shipping && SHIPPING_OPTIONS.contains(shipping)) {
      return shipping;
    }
    throw new OrderNotPlacedException(
        "The answer to the shipping question must be one of " + SHIPPING_OPTIONS + ".");
  }

  private static Map<String, Object> ask(
      McpSyncServerExchange exchange, String question, String message, Map<String, Object> schema)
      throws OrderNotPlacedException {
    ElicitResult result;
    try {
      result = exchange.createElicitation(ElicitFormRequest.builder(message, schema).build());
    } catch (McpError e) {
      throw new OrderNotPlacedException(
          "The %s question got an error instead of an answer: %s"
              .formatted(question, e.getMessage()));
    } catch (RuntimeException e) {
      // The SDK enforces its request timeout with Reactor, whose block() wraps the checked
      // TimeoutException in an unchecked one.
      if (Exceptions.unwrap(e) instanceof TimeoutException) {
        throw new OrderNotPlacedException(
            "The %s question got no answer in time.".formatted(question));
      }
      throw e;
    }
    return switch (result.action()) {
      case ACCEPT -> result.content() == null ? Map.of() : result.content();
      case DECLINE ->
          throw new OrderNotPlacedException(
              "The user declined the %s question.".formatted(question));
      case CANCEL ->
          throw new OrderNotPlacedException(
              "The user dismissed the %s question.".formatted(question));
    };
  }

  private static Map<String, Object> objectSchema(String property, Map<String, Object> schema) {
    return Map.of(
        "type", "object", "properties", Map.of(property, schema), "required", List.of(property));
  }

  private static CallToolResult result(boolean isError, String text) {
    return CallToolResult.builder().addTextContent(text).isError(isError).build();
  }

  /** Ends a call without placing an order; the message is what the client is shown. */
  private static final class OrderNotPlacedException extends Exception {
    private static final long serialVersionUID = 1L;

    OrderNotPlacedException(String message) {
      super(message);
    }
  }
}
