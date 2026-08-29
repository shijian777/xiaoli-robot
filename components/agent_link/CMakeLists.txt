file(READ "${CMAKE_CURRENT_LIST_DIR}/portal/portal.html" AGENT_LINK_PORTAL_HTML)
if(AGENT_LINK_PORTAL_HTML MATCHES
   "name=\"(endpoint|device_token)\"[^>]*value=\"[^\"]+\"")
    message(FATAL_ERROR
        "Production provisioning fields must not contain baked endpoint or token values")
endif()
unset(AGENT_LINK_PORTAL_HTML)

idf_component_register(
    SRCS
        "src/agent_link.cpp"
        "src/transport_ble.cpp"
        "src/transport_wifi.cpp"
        "src/wifi_provision.cpp"
        "src/wifi_endpoint.cpp"
        "src/protocol.cpp"
        "src/wifi_wire.cpp"
        "src/wifi_transport_utils.cpp"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "src"
    REQUIRES esp_common
    PRIV_REQUIRES log bt nvs_flash freertos json esp_app_format
                  esp_wifi esp_netif esp_event esp_http_server esp_timer lwip
                  esp_websocket_client mdns mbedtls
    EMBED_TXTFILES "portal/portal.html" "portal/connecting.html"
)
