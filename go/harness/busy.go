package harness

func (h *Harness) Busy(id string) (bool, error) {
	s, err := h.API().(*client).find(id)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running, nil
}
