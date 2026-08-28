idf_component_register(
    SRCS
        "test_main.cc"
        "../../../boards/rorolee-basic/bridge_message.cc"
        "../../../boards/rorolee-basic/mediation_state.cc"
        "../../../boards/rorolee-basic/mediation_runtime.cc"
        "../../../boards/rorolee-basic/pending_audio_store.cc"
    INCLUDE_DIRS
        "."
        "../../../components/agent_link/src"
        "../../../boards/rorolee-basic"
    PRIV_REQUIRES unity agent_link json heap esp_driver_gpio
)
