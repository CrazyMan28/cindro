package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type agentConfig struct {
	MachineID string `json:"machine_id"`
	Token     string `json:"token"`
	WsURL     string `json:"ws_url"`
}

func configPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("APPDATA"), "outpost-agent", "agent.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "outpost-agent", "agent.json")
}

func loadConfig() (agentConfig, error) {
	var c agentConfig
	data, err := os.ReadFile(configPath())
	if err != nil {
		return c, err
	}
	return c, json.Unmarshal(data, &c)
}

func handle(ctx context.Context, c *websocket.Conn, msg map[string]any) {
	switch msg["type"] {
	case "exec":
		cmd, _ := msg["cmd"].(string)
		timeout, _ := msg["timeout"].(float64)
		shell, _ := msg["shell"].(string)
		ok, code, out, errStr := runShell(cmd, timeout, shell)
		_ = wsjson.Write(ctx, c, map[string]any{
			"type": "exec_result", "req_id": msg["req_id"], "ok": ok,
			"exit_code": code, "output": out, "error": errStr})
	case "screenshot":
		b64, w, h, err := captureScreen()
		res := map[string]any{"type": "screenshot_result", "req_id": msg["req_id"],
			"ok": err == nil, "image_base64": b64, "width": w, "height": h,
			"captured_at": time.Now().UnixMilli(), "error": ""}
		if err != nil {
			res["error"] = err.Error()
		}
		_ = wsjson.Write(ctx, c, res)
	}
}

func connectOnce(cfg agentConfig) error {
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, cfg.WsURL+"?token="+cfg.Token, nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	c.SetReadLimit(64 * 1024 * 1024) // large screenshots
	if err := wsjson.Write(ctx, c, map[string]any{
		"type": "hello", "machine_id": cfg.MachineID, "os": runtime.GOOS,
		"arch": runtime.GOARCH}); err != nil {
		return err
	}
	for {
		var msg map[string]any
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			return err
		}
		go handle(ctx, c, msg)
	}
}

func main() {
	for {
		cfg, err := loadConfig()
		if err != nil {
			log.Printf("outpost-agent: failed to load config (%s): %v — retrying in 10s", configPath(), err)
			time.Sleep(10 * time.Second)
			continue
		}
		if err := connectOnce(cfg); err != nil {
			log.Printf("outpost-agent: connection lost: %v — reconnecting in 5s", err)
			time.Sleep(5 * time.Second) // reconnect with backoff
		}
	}
}
