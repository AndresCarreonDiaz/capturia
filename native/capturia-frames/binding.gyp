{
  "targets": [
    {
      "target_name": "capturia_frames",
      "sources": ["src/addon.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"]
      },
      "link_settings": {
        "libraries": [
          "-framework IOSurface",
          "-framework CoreGraphics",
          "-framework ImageIO",
          "-framework CoreFoundation",
          "-framework CoreServices",
          "-framework CoreMedia",
          "-framework CoreMediaIO",
          "-framework CoreVideo"
        ]
      }
    }
  ]
}
