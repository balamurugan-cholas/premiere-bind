# PremiereBind 1.0.0

PremiereBind for Adobe Premiere Pro, with installers for Windows and macOS.

## Install on Windows

1. Quit Premiere Pro.
2. Run `PremiereBind-1.0.0-Windows-x64-Setup.exe`.
3. Open Premiere Pro and choose **Window → Extensions → PremiereBind**.

The installer adds the panel, companion, startup entry, CEP configuration, and `.prbind` file association automatically.

## Install on macOS

The single `PremiereBind-1.0.0-macOS-Universal.pkg` supports both Apple Silicon and Intel Macs. Quit Premiere Pro, run the package, then open **Window → Extensions → PremiereBind**.

The package is currently unsigned. If macOS blocks it:

1. Open **System Settings → Privacy & Security**.
2. Scroll to the security message for PremiereBind and click **Open Anyway**.
3. Confirm **Open**, then run the installer again.

Architecture selection, panel installation, CEP configuration, helper permissions, automatic startup, and `.prbind` support are handled by the installer.

The first time PremiereBind starts, macOS may ask for **Accessibility** access so global shortcuts and native timeline copy/paste can work. Approve **PremiereBind Companion** in **System Settings → Privacy & Security → Accessibility**. This is a macOS privacy permission and cannot be pre-approved by an unsigned installer; the rest of PremiereBind works without additional software.
