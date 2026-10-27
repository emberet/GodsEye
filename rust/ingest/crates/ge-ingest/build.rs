fn main() -> Result<(), Box<dyn std::error::Error>> {
    // A vendored protoc keeps the build hermetic (no system protobuf compiler needed in CI).
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);
    println!("cargo:rerun-if-changed=proto");
    tonic_build::configure()
        .build_server(false)
        .compile_protos(
            &["proto/geyser.proto"],
            &[
                "proto",
                protoc_bin_vendored::include_path()?.to_str().unwrap_or(""),
            ],
        )?;
    Ok(())
}
