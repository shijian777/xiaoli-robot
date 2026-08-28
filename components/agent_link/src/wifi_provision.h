/**
 * @file wifi_provision.h
 * @brief SoftAP captive-portal WiFi provisioning for the WiFi transport
 * @details When the device has no stored WiFi credentials it broadcasts an open SoftAP
 *          The user connects to it; a DNS wildcard + HTTP redirect make the phone auto-open a configuration page
 *          The user picks their home WiFi and enters the password,the transport then joins as a station
 */

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** @brief Connection progress shown by the portal's /status endpoint. */
typedef enum {
    AL_PROV_IDLE = 0,     ///< Waiting for the user to submit credentials.
    AL_PROV_CONNECTING,   ///< Credentials received; the station is attempting to join.
    AL_PROV_CONNECTED,    ///< Station obtained an IP — provisioning succeeded.
    AL_PROV_FAILED,       ///< Station failed to join with the submitted credentials.
} al_prov_status_t;

enum {
    AL_PROV_SSID_CAPACITY = 33,
    AL_PROV_PASSWORD_CAPACITY = 65,
    AL_PROV_ENDPOINT_CAPACITY = 192,
    AL_PROV_DEVICE_TOKEN_CAPACITY = 257,
};

/** @brief Complete, callback-owned provisioning submission. */
typedef struct {
    char ssid[AL_PROV_SSID_CAPACITY];
    char password[AL_PROV_PASSWORD_CAPACITY];
    char endpoint[AL_PROV_ENDPOINT_CAPACITY];
    char device_token[AL_PROV_DEVICE_TOKEN_CAPACITY];
} al_prov_settings_t;

/**
 * @brief User submitted complete settings from the portal page.
 * @param settings Settings valid only for the duration of this call.
 * @note Copy the complete structure before returning; no field pointer may be retained.
 *       Invoked from the HTTP server task; return quickly (kick off the connect asynchronously).
 */
typedef void (*al_prov_settings_cb_t)(const al_prov_settings_t* settings);

/** @brief Validate an MVP Bridge URL without allocating or performing DNS. */
bool al_wifi_endpoint_valid(const char* endpoint);

/** @brief Validate a non-empty device token that fits fixed provisioning storage. */
bool al_wifi_device_token_valid(const char* token);

/** @brief Strictly parse one URL-encoded provisioning POST body. */
bool al_wifi_parse_provision_body(const char* body, size_t body_len, al_prov_settings_t* settings);

/**
 * @brief Start the captive portal (DNS redirect + HTTP config server).
 * @param ap_ssid   The SoftAP SSID the user sees (shown on the page for reassurance).
 * @param on_settings Called when the user submits complete settings.
 * @return ESP_OK on success, error code otherwise.
 * @note The caller (transport) must already have the SoftAP up in AP or APSTA mode.
 */
esp_err_t al_wifi_prov_start(const char* ap_ssid, al_prov_settings_cb_t on_settings);

/**
 * @brief Update the status the portal page polls after the user submits.
 * @param status New status.
 * @param ip     IP string when connected (may be NULL).
 * @param reason Short human-readable failure reason when failed (may be NULL).
 */
void al_wifi_prov_set_status(al_prov_status_t status, const char* ip, const char* reason);

/** @brief Tear down the portal (stops HTTP + DNS). Does not change WiFi mode. */
void al_wifi_prov_stop(void);

/** @brief Whether the portal is currently running. */
bool al_wifi_prov_active(void);

#ifdef __cplusplus
}
#endif
