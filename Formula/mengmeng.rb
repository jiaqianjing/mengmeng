class Mengmeng < Formula
  desc "Tiny Claude Code provider assistant for Claude Code providers"
  homepage "https://github.com/jiaqianjing/mengmeng"
  head "https://github.com/jiaqianjing/mengmeng.git", branch: "main"

  depends_on "node"

  def install
    libexec.install "bin"
    bin.install_symlink libexec/"bin/mm.js" => "mm"
  end

  test do
    assert_match "MengMeng", shell_output("#{bin}/mm --help")
  end
end
