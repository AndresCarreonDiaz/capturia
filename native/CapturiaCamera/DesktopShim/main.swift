// Profile-minting shim for the DESKTOP app bundle id (M8 slice 2).
//
// The Electron shell (com.capturia.desktop) needs a development provisioning
// profile that authorizes com.apple.developer.system-extension.install so the
// packaged app can activate its embedded camera extension without being
// SIGKILLed by AMFI. Xcode's automatic signing is the only sanctioned way to
// mint development profiles, and it mints them per bundle id, so this target
// exists purely to make -allowProvisioningUpdates register that bundle id
// with the System Extension capability and emit the profile. The binary is
// never shipped or run beyond a build smoke; mint-desktop-profile.sh drives
// the build and extracts Contents/embedded.provisionprofile from the result.
print("capturia-desktop-shim: exists only to mint the com.capturia.desktop development profile")
