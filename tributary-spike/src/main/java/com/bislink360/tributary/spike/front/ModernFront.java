package com.bislink360.tributary.spike.front;

import com.bislink360.tributary.spike.http.LoopbackHttpListener;
import io.modelcontextprotocol.modern.McpSchema.Implementation;
import io.modelcontextprotocol.modern.server.McpServer;
import io.modelcontextprotocol.modern.server.feature.ToolsFeature;
import io.modelcontextprotocol.modern.server.transport.HttpServletMcpTransport;
import java.net.URI;
import java.time.Duration;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The spike front: an MCP 2026-07-28 Streamable HTTP endpoint, built on the official Java SDK's
 * modern server preview, in front of one legacy MCP server. It answers {@code server/discover}
 * itself, lists the backend's tools and passes each {@code tools/call} to the backend.
 *
 * <p>A question the backend asks during a call is not carried to the client yet: the front's
 * session with the backend declares no elicitation capability. The front keeps no state per client;
 * it holds one backend session for its whole life. It listens on the loopback interface only. An
 * instance is safe to use from several threads.
 */
public final class ModernFront implements AutoCloseable {

  /** The port {@link #main} uses when none is given. */
  public static final int DEFAULT_PORT = 9100;

  /** The backend {@link #main} uses when none is given: the legacy orders server's default. */
  public static final URI DEFAULT_BACKEND = URI.create("http://127.0.0.1:9101/mcp");

  /** How long {@link #main} lets each request to the backend wait for its response. */
  public static final Duration DEFAULT_BACKEND_TIMEOUT = Duration.ofMinutes(2);

  private static final String MCP_PATH = "/mcp";

  private static final Logger LOG = LoggerFactory.getLogger(ModernFront.class);

  private final LoopbackHttpListener listener;
  private final HttpServletMcpTransport transport;
  private final LegacyBackend backend;

  private ModernFront(
      LoopbackHttpListener listener, HttpServletMcpTransport transport, LegacyBackend backend) {
    this.listener = listener;
    this.transport = transport;
    this.backend = backend;
  }

  /**
   * Connects to the legacy backend, reads its tools, then starts the front on the loopback
   * interface.
   *
   * @param port the TCP port, or 0 to pick a free one
   * @param backendEndpoint the legacy backend's MCP endpoint, for example {@code
   *     http://127.0.0.1:9101/mcp}
   * @param backendTimeout how long each request to the backend waits for its response
   * @return the running front
   * @throws IllegalArgumentException if the port is outside 0 to 65535 or the timeout is not
   *     positive
   * @throws IllegalStateException if the backend cannot be reached or the HTTP listener cannot
   *     start
   */
  public static ModernFront start(int port, URI backendEndpoint, Duration backendTimeout) {
    LoopbackHttpListener.requireValidPort(port);
    Objects.requireNonNull(backendEndpoint, "backendEndpoint");
    Objects.requireNonNull(backendTimeout, "backendTimeout");
    if (backendTimeout.isNegative() || backendTimeout.isZero()) {
      throw new IllegalArgumentException("backendTimeout must be positive, got " + backendTimeout);
    }

    LegacyBackend backend = LegacyBackend.connect(backendEndpoint, backendTimeout);
    try {
      McpServer server =
          McpServer.builder()
              .serverInfo(Implementation.builder("tributary-spike-front", "0.1.0").build())
              .feature(ToolsFeature.ofSync(BackendTools.readFrom(backend)))
              .build();
      var transport = HttpServletMcpTransport.builder(server).endpoint(MCP_PATH).build();
      var listener = LoopbackHttpListener.start(port, transport, MCP_PATH);
      return new ModernFront(listener, transport, backend);
    } catch (RuntimeException e) {
      backend.close();
      throw e;
    }
  }

  /**
   * Returns the MCP endpoint, for example {@code http://127.0.0.1:9100/mcp}.
   *
   * @return the URI clients connect to
   */
  public URI endpoint() {
    return listener.endpoint();
  }

  /**
   * Stops accepting requests, stops the HTTP listener and closes the backend session. Calls still
   * waiting for the backend are abandoned.
   *
   * @throws IllegalStateException if the HTTP listener cannot stop
   */
  @Override
  public void close() {
    transport.closeGracefully();
    try {
      listener.stop();
    } finally {
      backend.close();
    }
  }

  /**
   * Runs the front until the process ends.
   *
   * @param args an optional port ({@value #DEFAULT_PORT} if absent), then an optional backend
   *     endpoint ({@code http://127.0.0.1:9101/mcp} if absent)
   */
  public static void main(String[] args) {
    int port = args.length > 0 ? Integer.parseInt(args[0]) : DEFAULT_PORT;
    URI backendEndpoint = args.length > 1 ? URI.create(args[1]) : DEFAULT_BACKEND;
    ModernFront front = start(port, backendEndpoint, DEFAULT_BACKEND_TIMEOUT);
    Runtime.getRuntime().addShutdownHook(new Thread(front::close));
    LOG.info("Spike front listening on {}, backend {}", front.endpoint(), backendEndpoint);
  }
}
