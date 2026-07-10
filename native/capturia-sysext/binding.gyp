{
  "targets": [
    {
      "target_name": "capturia_sysext",
      "sources": ["src/addon.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"]
      },
      "link_settings": {
        "libraries": [
          "-framework Foundation",
          "-framework SystemExtensions"
        ]
      }
    }
  ]
}
