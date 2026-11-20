package com.bislink360.tributary.spike.legacy;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.HttpServletStreamableServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.ServerCapabilities;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Duration;
import java.util.Objects;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A legacy MCP test server: the official Java SDK's Streamable HTTP server, which negotiates
 * protocol version 2025-11-25 with current clients, serving the {@code place_order} tool that asks
 * the user two questions through {@code elicitation/create} before it answers.
 *
 * <p>It is the backend that Gate A bridges, so it listens on the loopback interface only. An
 * instance is safe to use from several threads.
 */
public final class OrdersLegacyServer implements AutoCloseable {

  /** The port {@link #main} uses when none is given. */
  public static final int DEFAULT_PORT = 9101;

  /** How long {@link #main} lets each question wait for the user's answer. */
  public static final Duration DEFAULT_ANSWER_TIMEOUT = Duration.ofMinutes(2);

  private static final String MCP_PATH = "/mcp";

  private static final Logger LOG = LoggerFactory.getLogger(OrdersLegacyServer.class);

  private final Server jetty;
  private final McpSyncServer mcp;

  private OrdersLegacyServer(Server jetty, McpSyncServer mcp) {
    this.jetty = jetty;
    this.mcp = mcp;
  }

  /**
   * Starts the server on the loopback interface.
   *
   * @param port the TCP port, or 0 to pick a free one
   * @param answerTimeout how long each question waits for the user's answer before the tool call
   *     ends with an error result
   * @return the running server
   * @throws IllegalArgumentException if the port is outside 0 to 65535 or the timeout is not
   *     positive
   * @throws IllegalStateException if the HTTP listener cannot start
   */
  public static OrdersLegacyServer start(int port, Duration answerTimeout) {
    if (port < 0 || port > 65_535) {
      throw new IllegalArgumentException("port must be between 0 and 65535, got " + port);
    }
    Objects.requireNonNull(answerTimeout, "answerTimeout");
    if (answerTimeout.isNegative() || answerTimeout.isZero()) {
      throw new IllegalArgumentException("answerTimeout must be positive, got " + answerTimeout);
    }

    var transport =
        HttpServletStreamableServerTransportProvider.builder()
            .jsonMapper(McpJsonDefaults.getMapper())
            .mcpEndpoint(MCP_PATH)
            .build();
    // The SDK applies the request timeout to server-to-client requests such as
    // elicitation/create, so it bounds how long a question waits for its answer.
    McpSyncServer mcp =
        McpServer.sync(transport)
            .serverInfo("orders-legacy", "0.1.0")
            .capabilities(ServerCapabilities.builder().tools(false).build())
            .requestTimeout(answerTimeout)
            .tools(PlaceOrderTool.specification())
            .build();

    Server jetty = new Server(new InetSocketAddress(InetAddress.getLoopbackAddress(), port));
    var servlet = new ServletHolder(transport);
    servlet.setAsyncSupported(true);
    var context = new ServletContextHandler();
    context.addServlet(servlet, "/*");
    jetty.setHandler(context);
    try {
      jetty.start();
    } catch (Exception e) {
      mcp.close();
      throw new IllegalStateException("Could not start the HTTP listener on port " + port, e);
    }
    return new OrdersLegacyServer(jetty, mcp);
  }

  /**
   * Returns the MCP endpoint, for example {@code http://127.0.0.1:9101/mcp}.
   *
   * @return the URI clients connect to
   */
  public URI endpoint() {
    var connector = (ServerConnector) jetty.getConnectors()[0];
    String host = InetAddress.getLoopbackAddress().getHostAddress();
    return URI.create("http://" + host + ":" + connector.getLocalPort() + MCP_PATH);
  }

  /**
   * Closes every MCP session and stops the HTTP listener. Tool calls still waiting for an answer
   * are abandoned.
   *
   * @throws IllegalStateException if the HTTP listener cannot stop
   */
  @Override
  public void close() {
    mcp.closeGracefully();
    try {
      jetty.stop();
    } catch (Exception e) {
      throw new IllegalStateException("Could not stop the HTTP listener", e);
    }
  }

  /**
   * Runs the server until the process ends.
   *
   * @param args an optional port; {@value #DEFAULT_PORT} if absent
   */
  public static void main(String[] args) {
    int port = args.length > 0 ? Integer.parseInt(args[0]) : DEFAULT_PORT;
    OrdersLegacyServer server = start(port, DEFAULT_ANSWER_TIMEOUT);
    Runtime.getRuntime().addShutdownHook(new Thread(server::close));
    LOG.info("Legacy orders server listening on {}", server.endpoint());
  }
}
