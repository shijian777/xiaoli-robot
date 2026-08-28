idf_component_register(
    SRCS
        "test_main.cc"
        "../../../boards/rorolee-basic/mediation_state.cc"
    INCLUDE_DIRS
        "."
        "../../../components/agent_link/src"
        "../../../boards/rorolee-basic"
    PRIV_REQUIRES unity agent_link
)
