package com.bislink360.tributary.spike.http;

import jakarta.servlet.Servlet;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.Objects;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;

/**
 * An HTTP listener on the loopback interface that serves one servlet. The spike's servers are test
 * fixtures and must not be reachable from other machines, so no other interface can be chosen. An
 * instance is safe to use from several threads.
 */
public final class LoopbackHttpListener {

  private static final int MAX_PORT = 65_535;

  private final Server jetty;
  private final String path;

  private LoopbackHttpListener(Server jetty, String path) {
    this.jetty = jetty;
    this.path = path;
  }

  /**
   * Starts listening and serves every request with {@code servlet}, with async support enabled.
   *
   * @param port the TCP port, or 0 to pick a free one
   * @param servlet the servlet that answers the requests
   * @param path the path {@link #endpoint()} reports, for example {@code /mcp}
   * @return the running listener
   * @throws IllegalArgumentException if the port is outside 0 to 65535
   * @throws IllegalStateException if the listener cannot start
   */
  public static LoopbackHttpListener start(int port, Servlet servlet, String path) {
    requireValidPort(port);
    Objects.requireNonNull(servlet, "servlet");
    Objects.requireNonNull(path, "path");

    Server jetty = new Server(new InetSocketAddress(InetAddress.getLoopbackAddress(), port));
    var holder = new ServletHolder(servlet);
    holder.setAsyncSupported(true);
    var context = new ServletContextHandler();
    context.addServlet(holder, "/*");
    jetty.setHandler(context);
    try {
      jetty.start();
    } catch (Exception e) {
      throw new IllegalStateException("Could not start the HTTP listener on port " + port, e);
    }
    return new LoopbackHttpListener(jetty, path);
  }

  /**
   * Checks a port before anything is built for it, so a caller can reject it early.
   *
   * @param port the TCP port to check, where 0 means "pick a free one"
   * @throws IllegalArgumentException if the port is outside 0 to 65535
   */
  public static void requireValidPort(int port) {
    if (port < 0 || port > MAX_PORT) {
      throw new IllegalArgumentException("port must be between 0 and 65535, got " + port);
    }
  }

  /**
   * Returns the address clients connect to, for example {@code http://127.0.0.1:9101/mcp}.
   *
   * @return the loopback URI with the listening port and the path given at start
   */
  public URI endpoint() {
    var connector = (ServerConnector) jetty.getConnectors()[0];
    String host = InetAddress.getLoopbackAddress().getHostAddress();
    return URI.create("http://" + host + ":" + connector.getLocalPort() + path);
  }

  /**
   * Stops listening. Requests still being served are abandoned.
   *
   * @throws IllegalStateException if the listener cannot stop
   */
  public void stop() {
    try {
      jetty.stop();
    } catch (Exception e) {
      throw new IllegalStateException("Could not stop the HTTP listener", e);
    }
  }
}
