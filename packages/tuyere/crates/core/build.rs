fn main() {
    println!("cargo:rerun-if-changed=vendor");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .include("vendor/uws")
        .file("vendor/uws_shim.cpp")
        .opt_level(3)
        .flag_if_supported("-fno-exceptions")
        .flag_if_supported("-fno-rtti")
        .flag_if_supported("-fno-threadsafe-statics")
        .cpp_link_stdlib(None) // the shim only uses header templates and memcpy
        .warnings(false)
        .compile("uws_shim");
}
