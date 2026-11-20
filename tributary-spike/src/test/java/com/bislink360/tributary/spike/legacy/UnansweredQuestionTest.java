package com.bislink360.tributary.spike.legacy;

import static com.bislink360.tributary.spike.legacy.OrdersLegacyServerTest.elicitingClient;
import static com.bislink360.tributary.spike.legacy.OrdersLegacyServerTest.placeOrderRequest;
import static com.bislink360.tributary.spike.legacy.OrdersLegacyServerTest.text;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.ElicitFormRequest;
import io.modelcontextprotocol.spec.McpSchema.ElicitResult;
import io.modelcontextprotocol.spec.McpSchema.ElicitResult.Action;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class UnansweredQuestionTest {

  @Test
  void endsTheCallWhenAQuestionStaysUnansweredPastTheTimeout() {
    var callEnded = new CountDownLatch(1);
    Function<ElicitFormRequest, ElicitResult> absentUser =
        request -> {
          awaitUninterruptibly(callEnded);
          return new ElicitResult(Action.ACCEPT, Map.of("quantity", 1));
        };

    CallToolResult result;
    try (OrdersLegacyServer server = OrdersLegacyServer.start(0, Duration.ofMillis(200));
        McpSyncClient client = elicitingClient(server.endpoint(), absentUser)) {
      client.initialize();
      try {
        result = client.callTool(placeOrderRequest("widgets"));
      } finally {
        callEnded.countDown();
      }
    }

    assertTrue(result.isError());
    assertEquals("The quantity question got no answer in time.", text(result));
  }

  private static void awaitUninterruptibly(CountDownLatch latch) {
    boolean interrupted = false;
    while (latch.getCount() > 0) {
      try {
        latch.await();
      } catch (InterruptedException e) {
        interrupted = true;
      }
    }
    if (interrupted) {
      Thread.currentThread().interrupt();
    }
  }
}
