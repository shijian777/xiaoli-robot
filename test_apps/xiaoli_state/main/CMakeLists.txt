idf_component_register(
    SRCS "test_main.cc"
    INCLUDE_DIRS "." "../../../components/agent_link/src"
    PRIV_REQUIRES unity agent_link
)
